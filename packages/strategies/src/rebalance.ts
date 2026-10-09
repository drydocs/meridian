// Rebalance-to-neutral trigger (#929).
//
// The control loop that keeps a delta-neutral book neutral: drift inside the
// band is left alone, and drift outside it is resized back to the target. Both
// functions are pure, take and return `FixedPointDecimal`, and do no I/O, so
// one rule serves the live strategy and any caller sizing an order elsewhere.
//
// Every amount here is quote notional. `netDelta` is the book's signed exposure
// in quote units, and the order is the change to apply to the hedge leg, also
// in quote units.

import { FixedPointDecimal } from "./types";

/**
 * A book's signed exposure.
 *
 * `netDelta` is quote notional, positive when the book is net long the base
 * asset. `notional` is what the band is measured against, normally the book's
 * equity.
 */
export interface RebalanceState {
  readonly netDelta: FixedPointDecimal;
  readonly notional: FixedPointDecimal;
}

/**
 * Whether the book has drifted far enough to rebalance.
 *
 * `band` is a fraction of `state.notional`, so `0.005` means 50 bps. The
 * trigger fires once `|netDelta|` is strictly greater than `notional × band`,
 * so a drift sitting exactly on the band is still inside it.
 *
 * @throws RangeError when `band` is negative.
 */
export function shouldRebalance(
  state: RebalanceState,
  band: FixedPointDecimal
): boolean {
  if (band.toStroops() < 0n) {
    throw new RangeError("band must not be negative");
  }
  return magnitude(state.netDelta).compareTo(state.notional.mul(band)) > 0;
}

/**
 * The signed hedge adjustment that moves the book from `state.netDelta` to
 * `target`, both in quote notional. A net-long book returns a positive number,
 * which means the short leg has to grow.
 *
 * Applying the result leaves the book at `target`. A `target` of zero restores
 * strict neutrality.
 */
export function computeRebalanceOrder(
  state: RebalanceState,
  target: FixedPointDecimal
): FixedPointDecimal {
  return state.netDelta.sub(target);
}

/** `value` without its sign. */
function magnitude(value: FixedPointDecimal): FixedPointDecimal {
  const stroops = value.toStroops();
  return FixedPointDecimal.fromStroops(stroops < 0n ? -stroops : stroops);
}
