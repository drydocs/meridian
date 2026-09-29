import { FixedPointDecimal } from "./types";

/**
 * Per-scenario cost schedule. All rates are fixed-point decimals expressed as
 * fractions of the notional (e.g. "0.003" = 0.3 % swap fee). networkFee is a
 * flat Stellar transaction cost in the same unit as the simulated asset
 * (typically USDC). Pass ZERO_COSTS to reproduce pre-cost results exactly.
 */
export interface CostSchedule {
  /** Swap fee rate charged on the gross notional of a swap. */
  swapFeeRate: FixedPointDecimal;
  /** Borrow interest spread applied to the borrowed notional per period. */
  borrowSpreadRate: FixedPointDecimal;
  /** Flat Stellar network fee per operation (in asset units, not stroops). */
  networkFee: FixedPointDecimal;
}

export type OperationType =
  | "swap"
  | "borrow"
  | "repay"
  | "deposit"
  | "withdraw";

export interface SimulatedOperation {
  type: OperationType;
  /** Gross notional of the operation in asset units. */
  notional: FixedPointDecimal;
  /** Gross result before costs (positive = gain, negative = loss). */
  grossResult: FixedPointDecimal;
}

export interface OperationResult {
  /** Net result after all applicable costs are deducted. */
  netResult: FixedPointDecimal;
  /** Total cost charged for this operation. */
  totalCost: FixedPointDecimal;
  /** Breakdown of individual cost components. */
  breakdown: {
    protocolFee: FixedPointDecimal;
    networkFee: FixedPointDecimal;
  };
}

/** Convenience zero-cost schedule — reproduces gross results unchanged. */
export const ZERO_COSTS: CostSchedule = {
  swapFeeRate: FixedPointDecimal.fromString("0"),
  borrowSpreadRate: FixedPointDecimal.fromString("0"),
  networkFee: FixedPointDecimal.fromString("0"),
};

/**
 * Applies the relevant costs from `schedule` to a simulated operation and
 * returns the net result together with a cost breakdown.
 *
 * Protocol fee selection:
 *   - swap     → swapFeeRate × notional
 *   - borrow   → borrowSpreadRate × notional
 *   - repay / deposit / withdraw → no protocol fee (network fee still applies)
 */
export function applyCosts(
  op: SimulatedOperation,
  schedule: CostSchedule
): OperationResult {
  let protocolFee: FixedPointDecimal;

  switch (op.type) {
    case "swap":
      protocolFee = op.notional.mul(schedule.swapFeeRate);
      break;
    case "borrow":
      protocolFee = op.notional.mul(schedule.borrowSpreadRate);
      break;
    default:
      protocolFee = FixedPointDecimal.fromString("0");
  }

  const totalCost = protocolFee.add(schedule.networkFee);
  const netResult = op.grossResult.sub(totalCost);

  return {
    netResult,
    totalCost,
    breakdown: { protocolFee, networkFee: schedule.networkFee },
  };
}
