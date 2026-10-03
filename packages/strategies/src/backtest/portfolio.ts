import { ZERO, applyBps, mulFixed } from "./decimal";
import type { Fixed } from "./decimal";
import type { MarketTick } from "./clock";
import type {
  AccrualRates,
  ExecutionModel,
  Order,
  OrderSide,
  PortfolioView,
} from "./strategy";

/** How much an accrual step added to cash before it was applied. */
export interface AccrualResult {
  readonly interest: Fixed;
  readonly funding: Fixed;
}

/** A priced, applied order. */
export interface Fill {
  readonly asset: string;
  readonly side: OrderSide;
  readonly quantity: Fixed;
  readonly markPrice: Fixed;
  readonly executionPrice: Fixed;
  readonly notional: Fixed;
  readonly fee: Fixed;
}

/** End-of-tick record for the metrics collector. */
export interface Snapshot {
  readonly tick: number;
  readonly timestamp: number;
  readonly cash: Fixed;
  readonly positions: Readonly<Record<string, Fixed>>;
  readonly value: Fixed;
}

/**
 * Mutable portfolio state. The runner is the only writer; strategies only ever
 * see the read-only `PortfolioView` surface.
 */
export class Portfolio implements PortfolioView {
  private cashValue: Fixed;
  private readonly holdings = new Map<string, Fixed>();

  constructor(initialCash: Fixed) {
    if (initialCash < ZERO) {
      throw new RangeError("Portfolio: initialCash must not be negative");
    }
    this.cashValue = initialCash;
  }

  get cash(): Fixed {
    return this.cashValue;
  }

  position(asset: string): Fixed {
    return this.holdings.get(asset) ?? ZERO;
  }

  /** Non-zero positions, asset keys sorted ascending. */
  positions(): Readonly<Record<string, Fixed>> {
    const out: Record<string, Fixed> = {};
    for (const asset of [...this.holdings.keys()].sort()) {
      const quantity = this.holdings.get(asset) ?? ZERO;
      if (quantity !== ZERO) out[asset] = quantity;
    }
    return out;
  }

  value(prices: ReadonlyMap<string, Fixed>): Fixed {
    let total = this.cashValue;
    for (const [asset, quantity] of this.holdings) {
      if (quantity === ZERO) continue;
      total += mulFixed(quantity, this.priceOf(prices, asset));
    }
    return total;
  }

  /**
   * Tick step 1: interest on cash, then funding on positions marked at
   * `prices`. Both are computed from the same pre-accrual state, so the net
   * cash effect is applied in one write.
   */
  accrue(
    rates: AccrualRates,
    prices: ReadonlyMap<string, Fixed>
  ): AccrualResult {
    const interest = mulFixed(this.cashValue, rates.cashRate);
    let funding = ZERO;
    for (const [asset, quantity] of this.holdings) {
      if (quantity === ZERO) continue;
      const notional = mulFixed(quantity, this.priceOf(prices, asset));
      funding += mulFixed(notional, rates.fundingRate);
    }
    this.cashValue += interest - funding;
    return { interest, funding };
  }

  /**
   * Tick step 3: price the order with slippage, charge the fee on notional,
   * then mutate cash and holdings. Buys must be fully funded; sells cannot
   * exceed the held quantity.
   */
  applyOrder(order: Order, markPrice: Fixed, execution: ExecutionModel): Fill {
    if (order.quantity <= ZERO) {
      throw new RangeError("Portfolio.applyOrder: quantity must be positive");
    }
    const buy = order.side === "buy";
    const bps = buy
      ? 10_000n + execution.slippageBps
      : 10_000n - execution.slippageBps;
    const executionPrice = applyBps(markPrice, bps);
    if (executionPrice <= ZERO) {
      throw new RangeError(
        "Portfolio.applyOrder: execution price must be positive"
      );
    }
    const notional = mulFixed(order.quantity, executionPrice);
    const fee = applyBps(notional, execution.feeBps);
    const held = this.position(order.asset);

    if (buy) {
      const cost = notional + fee;
      if (cost > this.cashValue) {
        throw new RangeError(
          `Portfolio.applyOrder: insufficient cash to buy "${order.asset}"`
        );
      }
      this.cashValue -= cost;
      this.holdings.set(order.asset, held + order.quantity);
    } else {
      if (order.quantity > held) {
        throw new RangeError(
          `Portfolio.applyOrder: insufficient "${order.asset}" to sell`
        );
      }
      this.cashValue += notional - fee;
      this.holdings.set(order.asset, held - order.quantity);
    }

    return {
      asset: order.asset,
      side: order.side,
      quantity: order.quantity,
      markPrice,
      executionPrice,
      notional,
      fee,
    };
  }

  /** Tick step 4: mark cash, positions and total value at `tick`'s prices. */
  snapshot(tick: MarketTick): Snapshot {
    return {
      tick: tick.index,
      timestamp: tick.timestamp,
      cash: this.cashValue,
      positions: this.positions(),
      value: this.value(tick.prices),
    };
  }

  private priceOf(prices: ReadonlyMap<string, Fixed>, asset: string): Fixed {
    const price = prices.get(asset);
    if (price === undefined) {
      throw new RangeError(`Portfolio: missing price for "${asset}"`);
    }
    return price;
  }
}
