import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";

/**
 * Order execution side:
 * - "buy": acquiring base asset using quote asset. Slippage increases effective execution price.
 * - "sell": liquidating base asset for quote asset. Slippage decreases effective execution price.
 */
export type OrderSide = "buy" | "sell";

/**
 * Interface defining a configurable slippage model.
 * Models are pure and deterministic given side, order quantity, and mid-market price.
 */
export interface SlippageModel {
  readonly name: string;
  /**
   * Computes the fractional slippage rate (e.g. 0.0005 for 5 bps).
   * Returned FixedPointDecimal represents the dimensionless rate (e.g. 5,000 stroops = 0.0005).
   */
  computeSlippageRate(
    side: OrderSide,
    quantity: FixedPointDecimal,
    midPrice: FixedPointDecimal
  ): FixedPointDecimal;
}

/**
 * Zero-slippage model: reproduces exact mid-price execution for baseline testing.
 */
export class ZeroSlippageModel implements SlippageModel {
  readonly name = "zero";

  computeSlippageRate(
    _side: OrderSide,
    _quantity: FixedPointDecimal,
    _midPrice: FixedPointDecimal
  ): FixedPointDecimal {
    return FixedPointDecimal.fromStroops(0n);
  }
}

export const ZERO_SLIPPAGE_MODEL = new ZeroSlippageModel();

/**
 * Fixed basis-point slippage model: applies a constant slippage rate regardless of order size.
 * 1 bps = 0.0001 (1,000 stroops).
 */
export class FixedBpsSlippageModel implements SlippageModel {
  readonly name = "fixed_bps";
  readonly bps: bigint;

  constructor(bps: bigint | number) {
    const rawBps = typeof bps === "number" ? BigInt(Math.round(bps)) : bps;
    if (rawBps < 0n) {
      throw new RangeError("Slippage basis points cannot be negative");
    }
    this.bps = rawBps;
  }

  computeSlippageRate(
    _side: OrderSide,
    _quantity: FixedPointDecimal,
    _midPrice: FixedPointDecimal
  ): FixedPointDecimal {
    // 1 bps = 10_000_000n / 10_000n = 1,000n stroops
    return FixedPointDecimal.fromStroops(this.bps * 1000n);
  }
}

/**
 * Size-proportional slippage model: models market impact as a linear function of order size.
 * Rate = baseBps + impactBps * (quantity / referenceVolume)
 */
export class SizeProportionalSlippageModel implements SlippageModel {
  readonly name = "size_proportional";
  readonly baseBps: bigint;
  readonly impactBps: bigint;
  readonly referenceVolume: FixedPointDecimal;

  constructor(options: {
    baseBps: bigint | number;
    impactBps: bigint | number;
    referenceVolume: FixedPointDecimal;
  }) {
    const rawBase =
      typeof options.baseBps === "number"
        ? BigInt(Math.round(options.baseBps))
        : options.baseBps;
    const rawImpact =
      typeof options.impactBps === "number"
        ? BigInt(Math.round(options.impactBps))
        : options.impactBps;

    if (rawBase < 0n) {
      throw new RangeError("baseBps cannot be negative");
    }
    if (rawImpact < 0n) {
      throw new RangeError("impactBps cannot be negative");
    }
    if (options.referenceVolume.toStroops() <= 0n) {
      throw new RangeError("referenceVolume must be positive");
    }

    this.baseBps = rawBase;
    this.impactBps = rawImpact;
    this.referenceVolume = options.referenceVolume;
  }

  computeSlippageRate(
    _side: OrderSide,
    quantity: FixedPointDecimal,
    _midPrice: FixedPointDecimal
  ): FixedPointDecimal {
    const baseStroops = this.baseBps * 1000n;
    const qtyStroops = quantity.toStroops();
    const refStroops = this.referenceVolume.toStroops();

    if (this.impactBps === 0n || qtyStroops === 0n) {
      return FixedPointDecimal.fromStroops(baseStroops);
    }

    const impactStroopsPerUnit = this.impactBps * 1000n;
    // Impact = (quantity * impactRate + ref/2) / ref
    const dynamicStroops =
      (qtyStroops * impactStroopsPerUnit + refStroops / 2n) / refStroops;

    return FixedPointDecimal.fromStroops(baseStroops + dynamicStroops);
  }
}

/**
 * Fee and cost schedule interface consumed by fill adjustments (#863 compatible).
 */
export interface CostSchedule {
  /** Fractional swap fee rate (e.g. 0.003 for 30 bps). Defaults to 0. */
  readonly swapFeeRate?: FixedPointDecimal;
  /** Fixed ledger fee per network operation. Defaults to 0. */
  readonly networkFeePerOperation?: FixedPointDecimal;
}

export const ZERO_COST_SCHEDULE: CostSchedule = {
  swapFeeRate: FixedPointDecimal.fromStroops(0n),
  networkFeePerOperation: FixedPointDecimal.fromStroops(0n),
};

/**
 * Input parameters for adjusting an order fill.
 */
export interface OrderFillRequest {
  /** "buy" or "sell". */
  readonly side: OrderSide;
  /** Quantity of the base asset being bought or sold. */
  readonly quantity: FixedPointDecimal;
  /** Mid-market price in quote asset units. */
  readonly midPrice: FixedPointDecimal;
  /** Configurable slippage model (defaults to ZeroSlippageModel). */
  readonly slippageModel?: SlippageModel;
  /** Fee and gas schedule (defaults to ZERO_COST_SCHEDULE). */
  readonly costSchedule?: CostSchedule;
  /** Number of ledger network operations charged (defaults to 1n). */
  readonly networkOperations?: bigint;
}

/**
 * Result of the fill model adjustment.
 * Contains effective price, notional amounts, itemized fees, and net cash flow.
 */
export interface OrderFillResult {
  readonly side: OrderSide;
  readonly quantity: FixedPointDecimal;
  readonly midPrice: FixedPointDecimal;
  readonly slippageRate: FixedPointDecimal;
  /** Price per unit after adjusting for slippage. */
  readonly effectivePrice: FixedPointDecimal;
  /** Gross quote notional before fees: quantity * effectivePrice. */
  readonly grossNotional: FixedPointDecimal;
  /** Trading fee charged against notional. */
  readonly tradingFee: FixedPointDecimal;
  /** Stellar network ledger fee charged for the fill operations. */
  readonly networkFee: FixedPointDecimal;
  /** Sum of trading and network fees. */
  readonly totalCost: FixedPointDecimal;
  /**
   * Net quote cash flow from the portfolio perspective:
   * - Buy: -(grossNotional + totalCost) (quote paid out)
   * - Sell: +(grossNotional - totalCost) (quote received)
   */
  readonly cashFlow: FixedPointDecimal;
  /** All-in unit price including slippage and proportional fees. */
  readonly effectiveNetPrice: FixedPointDecimal;
}

/**
 * Pure and deterministic order fill adjustment model (#879).
 * Applies slippage and transaction costs symmetrically to buy and sell fills.
 */
export function applyOrderFill(request: OrderFillRequest): OrderFillResult {
  const {
    side,
    quantity,
    midPrice,
    slippageModel = ZERO_SLIPPAGE_MODEL,
    costSchedule = ZERO_COST_SCHEDULE,
    networkOperations = 1n,
  } = request;

  const qtyStroops = quantity.toStroops();
  const midStroops = midPrice.toStroops();

  if (qtyStroops <= 0n) {
    throw new RangeError("Order quantity must be positive");
  }
  if (midStroops <= 0n) {
    throw new RangeError("Mid price must be positive");
  }

  // 1. Calculate slippage rate
  const slippageRate = slippageModel.computeSlippageRate(
    side,
    quantity,
    midPrice
  );
  const slipStroops = slippageRate.toStroops();

  // 2. Compute effective fill price (symmetric buy/sell treatment)
  // BUY: price shifts UP (worse for buyer)
  // SELL: price shifts DOWN (worse for seller)
  let effectivePriceStroops: bigint;
  if (side === "buy") {
    // Round UP against buyer: (mid * (1 + slip) + STROOPS - 1) / STROOPS
    effectivePriceStroops =
      (midStroops * (STROOPS_PER_UNIT + slipStroops) + STROOPS_PER_UNIT - 1n) /
      STROOPS_PER_UNIT;
  } else {
    // If slippage rate exceeds 100%, price floored at 0
    if (slipStroops >= STROOPS_PER_UNIT) {
      effectivePriceStroops = 0n;
    } else {
      // Round DOWN against seller: (mid * (1 - slip)) / STROOPS
      effectivePriceStroops =
        (midStroops * (STROOPS_PER_UNIT - slipStroops)) / STROOPS_PER_UNIT;
    }
  }
  const effectivePrice = FixedPointDecimal.fromStroops(effectivePriceStroops);

  // 3. Gross notional in quote units: (qty * effectivePrice + STROOPS/2) / STROOPS
  const grossNotionalStroops =
    (qtyStroops * effectivePriceStroops + STROOPS_PER_UNIT / 2n) /
    STROOPS_PER_UNIT;
  const grossNotional = FixedPointDecimal.fromStroops(grossNotionalStroops);

  // 4. Itemized costs
  const swapFeeRateStroops = costSchedule.swapFeeRate?.toStroops() ?? 0n;
  const tradingFeeStroops =
    swapFeeRateStroops > 0n
      ? (grossNotionalStroops * swapFeeRateStroops + STROOPS_PER_UNIT - 1n) /
        STROOPS_PER_UNIT
      : 0n;
  const tradingFee = FixedPointDecimal.fromStroops(tradingFeeStroops);

  const opFeeStroops = costSchedule.networkFeePerOperation?.toStroops() ?? 0n;
  const networkFeeStroops =
    networkOperations > 0n && opFeeStroops > 0n
      ? opFeeStroops * networkOperations
      : 0n;
  const networkFee = FixedPointDecimal.fromStroops(networkFeeStroops);

  const totalCostStroops = tradingFeeStroops + networkFeeStroops;
  const totalCost = FixedPointDecimal.fromStroops(totalCostStroops);

  // 5. Symmetric cash flow and effective net price
  let cashFlowStroops: bigint;
  let effectiveNetPriceStroops: bigint;

  if (side === "buy") {
    // Total quote spent = grossNotional + totalCost (negative cash flow)
    const totalOutflowStroops = grossNotionalStroops + totalCostStroops;
    cashFlowStroops = -totalOutflowStroops;
    effectiveNetPriceStroops =
      (totalOutflowStroops * STROOPS_PER_UNIT + qtyStroops - 1n) / qtyStroops;
  } else {
    // Total quote received = grossNotional - totalCost (floored at 0 if fees exceed gross)
    const netProceedsStroops =
      grossNotionalStroops > totalCostStroops
        ? grossNotionalStroops - totalCostStroops
        : 0n;
    cashFlowStroops = netProceedsStroops;
    effectiveNetPriceStroops =
      qtyStroops > 0n
        ? (netProceedsStroops * STROOPS_PER_UNIT) / qtyStroops
        : 0n;
  }

  const cashFlow = FixedPointDecimal.fromStroops(cashFlowStroops);
  const effectiveNetPrice = FixedPointDecimal.fromStroops(
    effectiveNetPriceStroops
  );

  return {
    side,
    quantity,
    midPrice,
    slippageRate,
    effectivePrice,
    grossNotional,
    tradingFee,
    networkFee,
    totalCost,
    cashFlow,
    effectiveNetPrice,
  };
}
