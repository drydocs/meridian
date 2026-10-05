import { Decimal } from "./decimal";

/**
 * Risk metrics over a strategy's return and drawdown series (#881).
 *
 * Conventions shared by all three metrics:
 *
 * - Arithmetic runs at scale 18, or the widest input scale when that is
 *   larger, so no input is rounded before an operation.
 * - `riskFreePerPeriod` is a per-period rate subtracted from the mean return.
 *   A caller holding an annual rate converts it first.
 * - Dispersion uses the population (n) second central moment, the usual
 *   backtest convention for a fixed sample. `varianceMode: "sample"` switches
 *   to the unbiased (n - 1) denominator, which divides the ratio by
 *   `sqrt(n / (n - 1))`.
 * - `sharpeRatio` returns the per-period ratio. `annualizeSharpe` scales it by
 *   `sqrt(periodsPerYear)`, the convention for i.i.d. periods. Use 365 for a
 *   daily stablecoin-vault series, 52 weekly, 12 monthly.
 * - `maxDrawdown` is a signed decline, so it is 0 or lower. `valueAtRisk` is a
 *   loss magnitude, so a positive result is a loss. The two signs differ by
 *   intent and each is documented on its own function.
 */

/** Scale used for ratio arithmetic. Stroops are too coarse for a variance. */
const METRICS_SCALE = 18;

export interface RiskMetrics {
  /** Most negative entry of the drawdown series, 0 or lower. */
  readonly maxDrawdown: Decimal;
  /** Per-period Sharpe ratio. Annualize with `annualizeSharpe`. */
  readonly sharpeRatio: Decimal;
  /** Loss magnitude at the requested confidence; negative means a gain. */
  readonly valueAtRisk: Decimal;
}

export type VarianceMode = "population" | "sample";

/**
 * `(mean(returns) - riskFreePerPeriod) / stdev(returns)`, computed per period.
 *
 * Throws for fewer than two returns, since one observation has no dispersion
 * to divide by, and for an all-identical series, which leaves a zero
 * deviation.
 */
export function sharpeRatio(
  returns: readonly Decimal[],
  riskFreePerPeriod: Decimal = Decimal.zero(),
  varianceMode: VarianceMode = "population"
): Decimal {
  if (returns.length < 2) {
    throw new RangeError(
      "sharpeRatio needs at least two returns to estimate dispersion"
    );
  }

  const scale = workingScale([...returns, riskFreePerPeriod]);
  const series = returns.map((value) => value.rescale(scale));
  const meanReturn = mean(series, scale);
  const excessMean = meanReturn.sub(riskFreePerPeriod);

  let sumSquaredDeviations = Decimal.zero(scale);
  for (const value of series) {
    const deviation = value.sub(meanReturn);
    sumSquaredDeviations = sumSquaredDeviations.add(deviation.mul(deviation));
  }

  const divisor =
    varianceMode === "population" ? series.length : series.length - 1;
  const variance = sumSquaredDeviations.div(
    Decimal.fromBigInt(BigInt(divisor), 0)
  );
  if (variance.isZero()) {
    throw new RangeError(
      "sharpeRatio is undefined for a zero-variance return series"
    );
  }

  return excessMean.div(decimalSqrt(variance));
}

/** Scales a per-period Sharpe ratio to a yearly one by `sqrt(periodsPerYear)`. */
export function annualizeSharpe(
  perPeriod: Decimal,
  periodsPerYear: Decimal | number
): Decimal {
  const periods = toDecimalInput(periodsPerYear);
  if (!periods.isPositive()) {
    throw new RangeError("periodsPerYear must be positive");
  }

  const scale = workingScale([perPeriod, periods]);
  return perPeriod.rescale(scale).mul(decimalSqrt(periods.rescale(scale)));
}

/**
 * Historical value at risk: the k-th smallest return, with
 * `k = ceil((1 - confidenceLevel) * returns.length)` clamped into `[1, n]`.
 *
 * The quantile is negated, so a positive result is the loss the
 * `(1 - confidenceLevel)` lower tail reaches, and a negative result means even
 * that tail stayed above break-even.
 *
 * Throws for a confidence outside the open interval `(0, 1)`, and for an empty
 * series, which has no order statistics.
 */
export function valueAtRisk(
  returns: readonly Decimal[],
  confidenceLevel: Decimal | number
): Decimal {
  const confidence = toDecimalInput(confidenceLevel);
  if (!confidence.isPositive() || !confidence.lt(Decimal.one())) {
    throw new RangeError("confidenceLevel must be strictly between 0 and 1");
  }
  if (returns.length === 0) {
    throw new RangeError("valueAtRisk needs at least one return");
  }

  const sorted = [...returns].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
  const count = Decimal.fromBigInt(BigInt(sorted.length), 0);
  const rank = ceilOf(Decimal.one().sub(confidence).mul(count));
  const clamped =
    rank < 1n
      ? 1n
      : rank > BigInt(sorted.length)
        ? BigInt(sorted.length)
        : rank;

  const threshold = sorted[Number(clamped) - 1];
  if (threshold === undefined) {
    throw new RangeError("valueAtRisk rank fell outside the series");
  }
  return threshold.neg();
}

/**
 * Most negative entry of the drawdown series, where each entry is the running
 * `value / peak - 1` decline. An empty series, and a series that never leaves
 * its running peak, both give `0`.
 */
export function maxDrawdown(drawdown: readonly Decimal[]): Decimal {
  const scale = workingScale(drawdown);
  let worst = Decimal.zero(scale);
  for (const value of drawdown) {
    if (value.lt(worst)) {
      worst = value.rescale(scale);
    }
  }
  return worst;
}

/** Computes all three metrics from the collector's series in one call. */
export function computeRiskMetrics(
  drawdown: readonly Decimal[],
  returns: readonly Decimal[],
  options: {
    riskFreePerPeriod?: Decimal;
    varianceMode?: VarianceMode;
    confidenceLevel?: Decimal | number;
  } = {}
): RiskMetrics {
  return {
    maxDrawdown: maxDrawdown(drawdown),
    sharpeRatio: sharpeRatio(
      returns,
      options.riskFreePerPeriod ?? Decimal.zero(),
      options.varianceMode ?? "population"
    ),
    valueAtRisk: valueAtRisk(returns, options.confidenceLevel ?? 0.95),
  };
}

/** Widest of the metrics scale and every input scale. */
function workingScale(values: readonly Decimal[]): number {
  let scale = METRICS_SCALE;
  for (const value of values) {
    if (value.scale > scale) {
      scale = value.scale;
    }
  }
  return scale;
}

/** Arithmetic mean of values that already share a scale, rounded once. */
function mean(values: readonly Decimal[], scale: number): Decimal {
  let sum = Decimal.zero(scale);
  for (const value of values) {
    sum = sum.add(value);
  }
  return sum.div(Decimal.fromBigInt(BigInt(values.length), 0));
}

/** Numbers arriving from JSON or a call site are read at the metrics scale. */
function toDecimalInput(value: Decimal | number): Decimal {
  return typeof value === "number"
    ? Decimal.fromString(String(value), METRICS_SCALE)
    : value;
}

/** Floor of the exact square root, at the argument's scale. */
function decimalSqrt(value: Decimal): Decimal {
  if (value.isNegative()) {
    throw new RangeError("Square root is undefined for a negative value");
  }
  return new Decimal(
    integerSqrt(value.raw * 10n ** BigInt(value.scale)),
    value.scale
  );
}

/**
 * Integer square root by Newton's method. The seed sits strictly above the
 * root, so the iteration decreases monotonically onto its floor.
 */
function integerSqrt(value: bigint): bigint {
  if (value < 2n) {
    return value;
  }
  let guess = 1n << BigInt((value.toString(2).length + 1) >> 1);
  for (;;) {
    const next = (guess + value / guess) >> 1n;
    if (next >= guess) {
      return guess;
    }
    guess = next;
  }
}

/**
 * Smallest integer greater than or equal to `value`. Truncation toward zero
 * is already the ceiling for a negative raw, so only positive remainders round
 * away from zero.
 */
function ceilOf(value: Decimal): bigint {
  const scaleFactor = 10n ** BigInt(value.scale);
  const quotient = value.raw / scaleFactor;
  if (value.raw % scaleFactor === 0n || value.raw < 0n) {
    return quotient;
  }
  return quotient + 1n;
}
