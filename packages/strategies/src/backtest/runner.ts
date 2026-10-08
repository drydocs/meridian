import { accruePortfolioTick, createPortfolioState } from "../accrual";
import type { FundingAccrualPosition } from "../accrual";
import type { SimulationClock } from "../clock";
import type { CostSchedule } from "../costs";
import { ZERO_COSTS } from "../costs";
import { Portfolio } from "../portfolio";
import type { Position, PriceSet } from "../portfolio";
import { ZERO_SLIPPAGE_MODEL, applyOrderFill } from "../slippage-model";
import type { SlippageModel } from "../slippage-model";
import { StrategyLifecycle } from "../strategy";
import type { Order, Strategy, StrategyContext } from "../strategy";
import { FixedPointDecimal, STROOPS_PER_UNIT } from "../types";
import type {
  AssetSymbol,
  FundingRate,
  PriceFeed,
  SimulationTimestamp,
} from "../types";

const ZERO = FixedPointDecimal.fromStroops(0n);
const MILLISECONDS_PER_SECOND = 1_000n;

/** Per-fill execution cost, applied through the #879 fill model. */
export interface ExecutionConfig {
  /** Defaults to zero slippage. */
  readonly slippageModel?: SlippageModel;
  /** Defaults to zero costs. */
  readonly costSchedule?: CostSchedule;
}

/**
 * Carrying cost applied over the interval between two ticks, so a run prorates
 * to the clock step rather than to a tick count and two step sizes agree over
 * the same window. Both rates are per second and both are optional; an omitted
 * rate accrues nothing.
 */
export interface AccrualConfig {
  /** Rate earned on idle cash. */
  readonly cashRatePerSecond?: FixedPointDecimal;
  /** Funding on each open position's marked notional, signed per #864. */
  readonly fundingRate?: FundingRate;
}

export interface BacktestConfig<TConfig = unknown> {
  /** Authoritative time source. Every tick it yields is visited, in order. */
  readonly clock: SimulationClock;
  /**
   * Traded assets. All of them are priced from `prices` on every tick and
   * handed to the strategy as market state.
   */
  readonly assets: readonly AssetSymbol[];
  readonly prices: PriceFeed;
  readonly strategy: Strategy<TConfig>;
  readonly strategyConfig: TConfig;
  readonly initialCash: FixedPointDecimal;
  readonly execution?: ExecutionConfig;
  readonly accrual?: AccrualConfig;
}

/** State recorded at the end of one tick, after that tick's fills. */
export interface BacktestSnapshot {
  readonly index: number;
  readonly timestamp: SimulationTimestamp;
  readonly cash: FixedPointDecimal;
  readonly positions: readonly Position[];
  readonly value: FixedPointDecimal;
}

export interface BacktestResult {
  readonly strategyName: string;
  readonly initialCash: FixedPointDecimal;
  readonly snapshots: readonly BacktestSnapshot[];
  /** Value after the closing orders have been filled, so positions are shut. */
  readonly finalValue: FixedPointDecimal;
  readonly totalInterest: FixedPointDecimal;
  readonly totalFunding: FixedPointDecimal;
  readonly totalFees: FixedPointDecimal;
}

/**
 * Runs one fully deterministic backtest of a single strategy.
 *
 * Every tick applies the same order of operations, and that order is part of
 * the result rather than an implementation detail:
 *
 *   1. accrual  - funding on each open position, then interest on idle cash,
 *                 both over the interval since the previous tick and both
 *                 marked at this tick's prices;
 *   2. strategy - `step`, then `rebalance`, driven through `StrategyLifecycle`
 *                 so the lifecycle order is enforced rather than assumed;
 *   3. fills    - each returned order is priced by `applyOrderFill` (slippage
 *                 first, then costs) and applied in the order it was returned;
 *   4. snapshot - cash, positions and marked value are recorded.
 *
 * The first tick has no preceding interval and so accrues nothing.
 *
 * After the final tick, `close` is called once and its orders are filled the
 * same way, which is what leaves `finalValue` in cash.
 */
export function runBacktest<TConfig = unknown>(
  config: BacktestConfig<TConfig>
): BacktestResult {
  const { clock, prices: priceFeed } = config;
  const lifecycle = new StrategyLifecycle(config.strategy);
  lifecycle.init({
    startingCapital: config.initialCash,
    config: config.strategyConfig,
  });

  const portfolio = new Portfolio(config.initialCash);
  const snapshots: BacktestSnapshot[] = [];
  const execution = config.execution ?? {};
  let remainders: Readonly<Record<string, bigint>> = {};
  let totalInterest = ZERO;
  let totalFunding = ZERO;
  let previous: SimulationTimestamp | null = null;
  let index = 0;

  for (const timestamp of clock.ticks()) {
    const market = marketAt(priceFeed, config.assets, timestamp);

    if (previous !== null) {
      const elapsed = timestamp - previous;

      // Funding goes through the accrual engine so fractional-stroop accrual
      // carries between ticks instead of being truncated away. The engine
      // hands that carry back inside a `PortfolioState`, and the runner keeps
      // only the remainders, because `Portfolio` owns cash and positions.
      const accrued = accruePortfolioTick(
        {
          ...createPortfolioState(portfolio.cash),
          accrualRemainders: remainders,
        },
        {
          elapsedMilliseconds: elapsed,
          borrowPositions: [],
          fundingPositions: fundingPositions(portfolio, market, config.accrual),
        }
      );
      remainders = accrued.portfolio.accrualRemainders;

      let funding = ZERO;
      for (const transaction of accrued.transactions) {
        if (transaction.type !== "funding-payment") continue;
        funding = funding.add(transaction.amount);
      }

      const interest = cashInterest(portfolio.cash, config.accrual, elapsed);
      totalFunding = totalFunding.add(funding);
      totalInterest = totalInterest.add(interest);
      portfolio.applyCashFlow(funding.add(interest));
    }

    const context: StrategyContext = { market, portfolio };
    lifecycle.step(context);

    for (const order of lifecycle.rebalance(context)) {
      fill(portfolio, order, market.prices, execution);
    }

    snapshots.push({
      index,
      timestamp,
      cash: portfolio.cash,
      positions: portfolio.positions(),
      value: portfolio.totalValue(market.prices),
    });

    previous = timestamp;
    index += 1;
  }

  // `clock.end` is the final tick, so closing orders are priced at the same
  // mark the last snapshot was taken at.
  const closing: StrategyContext = {
    market: marketAt(priceFeed, config.assets, clock.end),
    portfolio,
  };
  for (const order of lifecycle.close(closing)) {
    fill(portfolio, order, closing.market.prices, execution);
  }

  return {
    strategyName: config.strategy.name,
    initialCash: config.initialCash,
    snapshots,
    finalValue: portfolio.totalValue(closing.market.prices),
    totalInterest,
    totalFunding,
    totalFees: portfolio.fees,
  };
}

/** Canonical, byte-stable JSON for a snapshot sequence. */
export function serializeSnapshots(
  snapshots: readonly BacktestSnapshot[]
): string {
  return JSON.stringify(
    snapshots.map((snapshot) => ({
      index: snapshot.index,
      timestamp: snapshot.timestamp,
      cash: snapshot.cash.toString(),
      positions: snapshot.positions.map((position) => ({
        asset: position.asset,
        size: position.size.toString(),
        basis: position.basis.toString(),
      })),
      value: snapshot.value.toString(),
    }))
  );
}

/** Prices every configured asset at one instant. */
function marketAt(
  priceFeed: PriceFeed,
  assets: readonly AssetSymbol[],
  timestamp: SimulationTimestamp
): StrategyContext["market"] {
  const prices = new Map<AssetSymbol, FixedPointDecimal>();
  for (const asset of assets) {
    prices.set(asset, priceFeed.getSpotPrice(asset, timestamp));
  }
  return { timestamp, prices };
}

/** One funding entry per open position, at its marked notional. */
function fundingPositions(
  portfolio: Portfolio,
  market: StrategyContext["market"],
  accrual: AccrualConfig | undefined
): FundingAccrualPosition[] {
  const rate = accrual?.fundingRate;
  if (rate === undefined) return [];

  const positions: FundingAccrualPosition[] = [];
  for (const position of portfolio.positions()) {
    const price = market.prices.get(position.asset);
    if (price === undefined) {
      throw new RangeError(
        `runBacktest: no price for "${position.asset}" to accrue funding on`
      );
    }
    const size = FixedPointDecimal.fromStroops(
      abs(position.size.toStroops())
    ).mul(price);
    positions.push({ id: position.asset, notional: size, rate });
  }
  return positions;
}

/**
 * `notional x ratePerSecond x elapsed`, in stroops so the truncation happens
 * once, matching the accrual engine's own path.
 */
function cashInterest(
  cash: FixedPointDecimal,
  accrual: AccrualConfig | undefined,
  elapsedMilliseconds: number
): FixedPointDecimal {
  const rate = accrual?.cashRatePerSecond;
  if (rate === undefined) return ZERO;
  return FixedPointDecimal.fromStroops(
    (cash.toStroops() * rate.toStroops() * BigInt(elapsedMilliseconds)) /
      (STROOPS_PER_UNIT * MILLISECONDS_PER_SECOND)
  );
}

/** Prices one order through the fill model and applies it to the portfolio. */
function fill(
  portfolio: Portfolio,
  order: Order,
  prices: PriceSet,
  execution: ExecutionConfig
): void {
  const midPrice = prices.get(order.asset);
  if (midPrice === undefined) {
    throw new RangeError(`runBacktest: no price for "${order.asset}"`);
  }

  const signed = order.size.toStroops();
  const adjusted = applyOrderFill({
    side: signed < 0n ? "sell" : "buy",
    quantity: FixedPointDecimal.fromStroops(abs(signed)),
    midPrice,
    slippageModel: execution.slippageModel ?? ZERO_SLIPPAGE_MODEL,
    costSchedule: execution.costSchedule ?? ZERO_COSTS,
  });

  portfolio.applyFill({
    asset: order.asset,
    size: order.size,
    price: adjusted.effectivePrice,
    fee: adjusted.totalCost,
  });
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
