import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";
import type { FundingRate, Position } from "./types";

/**
 * Computes the funding payment accrued on a short position over an elapsed
 * interval.
 *
 * ## Formula
 *
 *   payment = notional × ratePerSecond × elapsedSeconds
 *
 * All arithmetic is performed in stroops (integer bigint) to guarantee no
 * floating-point rounding.  The intermediate product is divided by
 * STROOPS_PER_UNIT once (not twice) because `notional` is already in stroops
 * and `ratePerSecond` encodes "per unit of notional" — one STROOPS_PER_UNIT
 * cancels between the two:
 *
 *   stroops_notional × (stroops_rate / STROOPS_PER_UNIT) × seconds
 *   = (stroops_notional × stroops_rate × seconds) / STROOPS_PER_UNIT
 *
 * ## Sign convention (short leg perspective)
 *
 *   positive rate → longs pay shorts → short *receives* funding → result > 0
 *   negative rate → shorts pay longs → short *pays* funding    → result < 0
 *   zero notional or zero elapsed   → result == 0
 *
 * @param position      The short position whose notional is used as base size.
 * @param fundingRate   The per-second funding rate (can be negative).
 * @param elapsedSeconds  Whole seconds elapsed since the last accrual (≥ 0).
 * @returns A FixedPointDecimal representing the funding amount from the short
 *          side's perspective (positive = received, negative = paid).
 */
export function accrueFunding(
  position: Position,
  fundingRate: FundingRate,
  elapsedSeconds: bigint
): FixedPointDecimal {
  if (elapsedSeconds < 0n) {
    throw new RangeError(
      `accrueFunding: elapsedSeconds must be ≥ 0, got ${elapsedSeconds}`
    );
  }

  const notionalStroops = position.notional.toStroops();
  const rateStroops = fundingRate.ratePerSecond.toStroops();

  // Integer-only path: no floats anywhere.
  const raw = (notionalStroops * rateStroops * elapsedSeconds) / STROOPS_PER_UNIT;

  return FixedPointDecimal.fromStroops(raw);
}

/**
 * Computes the basis between a spot price and a derivative price.
 *
 * ## Formula
 *
 *   basis = spot − derivativePrice
 *
 * A positive basis means the spot trades above the derivative (backwardation).
 * A negative basis means the spot trades below the derivative (contango).
 *
 * The result is returned as a FixedPointDecimal so consumers can compare it
 * directly to funding payments and position notionals without unit conversion.
 *
 * @param spot             The current spot price of the underlying asset.
 * @param derivativePrice  The current price of the derivative (future/perp).
 * @returns basis = spot − derivativePrice  (can be negative).
 */
export function computeBasis(
  spot: FixedPointDecimal,
  derivativePrice: FixedPointDecimal
): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(
    spot.toStroops() - derivativePrice.toStroops()
  );
}
