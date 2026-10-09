// Volatility estimators over a price series (#867).
//
// Both estimators read the shared `TimeSeries` (see ./time-series) and return
// one `Decimal` per stored point, at the series scale, so the outputs stay
// index-aligned with `series.points`. A point has no return behind it until
// the point after it exists, which makes the first value always zero.
//
// Rolling is the population standard deviation of simple returns over the
// trailing `window` returns, with a partial window at the start of the series.
// EWMA seeds variance from the first observed return, then updates it with
// `decay * variance + (1 - decay) * return^2`.
//
// `decay` is applied at its own scale rather than rescaled to the series
// scale, so a decay finer than the series scale is not rounded before use.

import { Decimal } from "./decimal";
import type { TimeSeries } from "./time-series";

/**
 * Population standard deviation of simple returns for every point, over the
 * trailing `window` returns.
 *
 * @throws RangeError when `window` is not a positive safe integer, or when a
 * price is not positive.
 */
export function rollingVolatility(
  series: TimeSeries,
  window: number
): Decimal[] {
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new RangeError("window must be a positive safe integer");
  }
  if (series.size === 0) return [];

  const returns = getReturns(series);
  const results = [Decimal.zero(series.scale)];
  for (let index = 1; index < series.size; index += 1) {
    const start = Math.max(0, index - window);
    results.push(standardDeviation(returns.slice(start, index), series.scale));
  }
  return results;
}

/**
 * EWMA volatility for every point, with variance seeded by the first observed
 * return.
 *
 * @throws RangeError when `decayFactor` is not strictly between zero and one,
 * or when a price is not positive.
 */
export function ewmaVolatility(
  series: TimeSeries,
  decayFactor: Decimal
): Decimal[] {
  const scaleFactor = 10n ** BigInt(decayFactor.scale);
  if (decayFactor.raw <= 0n || decayFactor.raw >= scaleFactor) {
    throw new RangeError(
      "decayFactor must be greater than zero and less than one"
    );
  }
  if (series.size === 0) return [];

  const scale = series.scale;
  const oneMinusDecay = Decimal.one(decayFactor.scale).sub(decayFactor);
  const returns = getReturns(series);
  const results = [Decimal.zero(scale)];
  let variance = Decimal.zero(scale);

  for (const [index, value] of returns.entries()) {
    const squaredReturn = value.mul(value);
    variance =
      index === 0
        ? squaredReturn
        : decayFactor
            .mul(variance)
            .add(oneMinusDecay.mul(squaredReturn))
            .rescale(scale);
    results.push(squareRoot(variance));
  }
  return results;
}

/** Simple returns between consecutive points, at the series scale. */
function getReturns(series: TimeSeries): Decimal[] {
  const one = Decimal.one(series.scale);
  const returns: Decimal[] = [];
  let previous: Decimal | null = null;

  for (const point of series.points) {
    if (point.value.raw <= 0n) {
      throw new RangeError("volatility: prices must be greater than zero");
    }
    if (previous !== null) {
      returns.push(point.value.div(previous).sub(one));
    }
    previous = point.value;
  }
  return returns;
}

/** Population standard deviation of `values`, which are held at `scale`. */
function standardDeviation(values: readonly Decimal[], scale: number): Decimal {
  if (values.length === 0) return Decimal.zero(scale);

  let sum = 0n;
  let sumSquares = 0n;
  for (const value of values) {
    sum += value.raw;
    sumSquares += value.raw * value.raw;
  }

  const count = BigInt(values.length);
  const numerator = count * sumSquares - sum * sum;
  const denominator = count * count * 10n ** BigInt(scale);
  const variance = Decimal.fromBigInt(
    divideHalfUp(numerator, denominator),
    scale
  );
  return squareRoot(variance);
}

/** `sqrt(value)` at the value's scale, rounded to the nearest stroop. */
function squareRoot(value: Decimal): Decimal {
  if (value.raw <= 0n) return Decimal.zero(value.scale);

  const scaledValue = value.raw * 10n ** BigInt(value.scale);
  let root = integerSquareRoot(scaledValue);
  if (scaledValue - root * root > root) root += 1n;
  return Decimal.fromBigInt(root, value.scale);
}

/** Newton's method on a non-negative integer, truncating toward zero. */
function integerSquareRoot(value: bigint): bigint {
  if (value < 2n) return value;

  let estimate = value;
  let next = (estimate + 1n) / 2n;
  while (next < estimate) {
    estimate = next;
    next = (estimate + value / estimate) / 2n;
  }
  return estimate;
}

/** Integer division rounding halves away from zero. */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}
