import { Decimal } from "./decimal";

export interface VolatilityPricePoint {
  readonly timestampMs: number;
  readonly price: Decimal;
}

/**
 * Returns population standard deviation of simple returns for every point.
 * Partial windows are used at the start; the first point is zero because it
 * has no preceding price from which to calculate a return.
 */
export function rollingVolatility(
  series: readonly VolatilityPricePoint[],
  window: number
): Decimal[] {
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new RangeError("window must be a positive safe integer");
  }

  const returns = getReturns(series);
  if (series.length === 0) return [];

  const scale = series[0]!.price.scale;
  const results = [Decimal.zero(scale)];

  for (let index = 1; index < series.length; index += 1) {
    const start = Math.max(0, index - window);
    results.push(standardDeviation(returns.slice(start, index), scale));
  }

  return results;
}

/**
 * Returns EWMA volatility aligned to the input points. The first observed
 * return seeds variance; subsequent returns use lambda * prior + (1-lambda) * r^2.
 * The initial point is zero because no return is available yet.
 */
export function ewmaVolatility(
  series: readonly VolatilityPricePoint[],
  decayFactor: Decimal
): Decimal[] {
  const scale = series[0]?.price.scale ?? decayFactor.scale;
  const decay = decayFactor.rescale(scale);
  const scaleFactor = 10n ** BigInt(scale);
  if (decay.raw <= 0n || decay.raw >= scaleFactor) {
    throw new RangeError("decayFactor must be greater than zero and less than one");
  }
  if (series.length === 0) return [];

  const returns = getReturns(series);
  const oneMinusDecay = Decimal.one(scale).sub(decay);
  const results = [Decimal.zero(scale)];
  let variance = Decimal.zero(scale);

  for (const [index, value] of returns.entries()) {
    const squaredReturn = value.mul(value);
    variance =
      index === 0
        ? squaredReturn
        : decay.mul(variance).add(oneMinusDecay.mul(squaredReturn));
    results.push(squareRoot(variance));
  }

  return results;
}

function getReturns(series: readonly VolatilityPricePoint[]): Decimal[] {
  const first = series[0];
  if (!first) return [];

  const scale = first.price.scale;
  const one = Decimal.one(scale);
  let previousTimestamp: number | undefined;
  let previousPrice: Decimal | undefined;
  const returns: Decimal[] = [];

  for (const point of series) {
    if (
      !Number.isSafeInteger(point.timestampMs) ||
      (previousTimestamp !== undefined && point.timestampMs <= previousTimestamp)
    ) {
      throw new RangeError("price timestamps must be increasing safe integers");
    }
    const price = point.price.rescale(scale);
    if (price.raw <= 0n) {
      throw new RangeError("prices must be greater than zero");
    }
    if (previousPrice) returns.push(price.div(previousPrice).sub(one));
    previousPrice = price;
    previousTimestamp = point.timestampMs;
  }

  return returns;
}

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
  const denominator = count * count * (10n ** BigInt(scale));
  const varianceRaw = divideHalfUp(numerator, denominator);
  return squareRoot(Decimal.fromBigInt(varianceRaw, scale));
}

function squareRoot(value: Decimal): Decimal {
  if (value.raw <= 0n) return Decimal.zero(value.scale);

  const scaledValue = value.raw * (10n ** BigInt(value.scale));
  let root = integerSquareRoot(scaledValue);
  if (scaledValue - root * root > root) root += 1n;
  return Decimal.fromBigInt(root, value.scale);
}

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

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}