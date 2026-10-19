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
  /** Flat Stellar network fee per operation (in asset units, not stroops). */
  networkFee: FixedPointDecimal;
}

/** A zero-cost schedule, so a net result equals the gross result it was given. */
export const ZERO_COSTS: CostSchedule = {
  swapFeeRate: FixedPointDecimal.fromString("0"),
  networkFee: FixedPointDecimal.fromString("0"),
};
