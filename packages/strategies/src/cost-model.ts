import { DEFAULT_SCALE, FixedDecimal } from "./fixed";

export interface CostSchedule {
  /** Fraction charged against swap notional, e.g. 0.003 for 30 bps. */
  readonly swapFeeRate: FixedDecimal;
  /** Fraction charged against borrowed notional for one modeled period. */
  readonly borrowSpreadRate: FixedDecimal;
  /** Fixed cost charged for every network operation. */
  readonly networkFeePerOperation: FixedDecimal;
}

export interface SimulatedOperation {
  readonly grossResult: FixedDecimal;
  readonly swapNotional?: FixedDecimal;
  readonly borrowedNotional?: FixedDecimal;
  readonly networkOperations?: bigint;
}

export interface AppliedCosts {
  readonly swapFee: FixedDecimal;
  readonly borrowSpread: FixedDecimal;
  readonly networkFee: FixedDecimal;
  readonly totalCost: FixedDecimal;
  readonly netResult: FixedDecimal;
}

export const ZERO_COST_SCHEDULE: CostSchedule = {
  swapFeeRate: FixedDecimal.fromScaled(0n),
  borrowSpreadRate: FixedDecimal.fromScaled(0n),
  networkFeePerOperation: FixedDecimal.fromScaled(0n),
};

function zeroFor(operation: SimulatedOperation): FixedDecimal {
  return FixedDecimal.fromScaled(0n, operation.grossResult.scale);
}

function requireScale(value: FixedDecimal, scale: bigint, name: string): void {
  if (value.scale !== scale) throw new RangeError(`${name} uses a different scale`);
}

/** Applies a data-driven cost schedule without converting money to number. */
export function applyOperationCosts(
  operation: SimulatedOperation,
  schedule: CostSchedule,
): AppliedCosts {
  const scale = operation.grossResult.scale;
  requireScale(schedule.swapFeeRate, scale, "swapFeeRate");
  requireScale(schedule.borrowSpreadRate, scale, "borrowSpreadRate");
  requireScale(schedule.networkFeePerOperation, scale, "networkFeePerOperation");
  if (operation.swapNotional) requireScale(operation.swapNotional, scale, "swapNotional");
  if (operation.borrowedNotional) requireScale(operation.borrowedNotional, scale, "borrowedNotional");

  const swapFee = operation.swapNotional
    ? operation.swapNotional.multiply(schedule.swapFeeRate)
    : zeroFor(operation);
  const borrowSpread = operation.borrowedNotional
    ? operation.borrowedNotional.multiply(schedule.borrowSpreadRate)
    : zeroFor(operation);
  const networkFee = schedule.networkFeePerOperation.multiplyInteger(
    operation.networkOperations ?? 0n,
  );
  const totalCost = swapFee.add(borrowSpread).add(networkFee);

  return {
    swapFee,
    borrowSpread,
    networkFee,
    totalCost,
    netResult: operation.grossResult.subtract(totalCost),
  };
}

export function fixed(value: string): FixedDecimal {
  return FixedDecimal.fromString(value, DEFAULT_SCALE);
}
