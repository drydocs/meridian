import { Decimal } from "./decimal";

/**
 * Risk metrics over a strategy's return and drawdown series (#881).
 *
 * Conventions shared by the metrics:
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
 * - `maxDrawdown` is a non-negative magnitude, so it is 0 or higher.
 *   `valueAtRisk` is also a loss magnitude, so a positive result is a loss.
 *   Both are quoted as positive losses, matching the report field convention.
 *   `conditionalValueAtRisk` follows the same sign as `valueAtRisk`.
 * - `downsideDeviation`, `sortinoRatio` and `calmarRatio` (#1434) use the
 *   same fixed-point arithmetic. The minimum acceptable return (MAR) is a
 *   per-period rate and defaults to 0.
 */

/** Scale used for ratio arithmetic. Stroops are too coarse for a variance. */
const METRICS_SCALE = 18;

export interface RiskMetrics {
  /** Most negative entry of the drawdown series as a magnitude, 0 or higher. */
  readonly maxDrawdown: Decimal;
  /** Per-period Sharpe ratio. Annualize with `annualizeSharpe`. */
  readonly sharpeRatio: Decimal;
  /** Loss magnitude at the requested confidence; negative means a gain. */
  readonly valueAtRisk: Decimal;
  /**
   * Mean loss of the returns at or below the VaR threshold, at the same
   * confidence. A loss magnitude like `valueAtRisk`, and never below it.
   */
  readonly conditionalValueAtRisk: Decimal;
  /** Per-period downside deviation below the minimum acceptable return, 0 or higher. */
  readonly downsideDeviation: Decimal;
  /**
   * Per-period Sortino ratio, or `null` when the downside deviation is zero
   * (no return fell below the minimum acceptable return).
   */
  readonly sortinoRatio: Decimal | null;
  /**
   * Calmar ratio over `periodsPerYear`, or `null` when the maximum drawdown
   * is zero and the ratio has no denominator.
   */
  readonly calmarRatio: Decimal | null;
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
 * Historical conditional value at risk (expected shortfall): the mean of every
 * return at or below the `valueAtRisk` threshold at the same confidence,
 * negated so a positive result is a loss.
 *
 * The tail includes every return tied with the threshold, so the result never
 * reports a smaller loss than `valueAtRisk`. Throws for the same inputs
 * `valueAtRisk` rejects.
 */
export function conditionalValueAtRisk(
  returns: readonly Decimal[],
  confidenceLevel: Decimal | number
): Decimal {
  const threshold = valueAtRisk(returns, confidenceLevel).neg();
  const scale = workingScale(returns);
  const tail = returns
    .filter((value) => value.lte(threshold))
    .map((value) => value.rescale(scale));
  return mean(tail, scale).neg();
}

/**
 * Downside deviation below a per-period minimum acceptable return (MAR):
 * `sqrt(sum(min(0, r - MAR)^2) / n)`, with `n` the full number of returns.
 *
 * Returns above the MAR count in `n` but add nothing to the sum, the usual
 * Sortino convention. The result is 0 or higher, and 0 when no return fell
 * below the MAR. Throws for an empty series.
 */
export function downsideDeviation(
  returns: readonly Decimal[],
  minimumAcceptableReturn: Decimal = Decimal.zero()
): Decimal {
  if (returns.length === 0) {
    throw new RangeError("downsideDeviation needs at least one return");
  }

  const scale = workingScale([...returns, minimumAcceptableReturn]);
  const target = minimumAcceptableReturn.rescale(scale);
  let sumSquaredShortfalls = Decimal.zero(scale);
  for (const value of returns) {
    const shortfall = value.rescale(scale).sub(target);
    if (shortfall.isNegative()) {
      sumSquaredShortfalls = sumSquaredShortfalls.add(shortfall.mul(shortfall));
    }
  }

  return decimalSqrt(
    sumSquaredShortfalls.div(Decimal.fromBigInt(BigInt(returns.length), 0))
  );
}

/**
 * `(mean(returns) - MAR) / downsideDeviation(returns, MAR)`, per period.
 * Annualize it like Sharpe, with `annualizeSharpe(sortino, periodsPerYear)`.
 *
 * Throws for an empty series, and for a zero downside deviation, which leaves
 * nothing to divide by (every return at or above the MAR).
 */
export function sortinoRatio(
  returns: readonly Decimal[],
  minimumAcceptableReturn: Decimal = Decimal.zero()
): Decimal {
  const deviation = downsideDeviation(returns, minimumAcceptableReturn);
  if (deviation.isZero()) {
    throw new RangeError(
      "sortinoRatio is undefined when no return falls below the minimum acceptable return"
    );
  }

  const scale = workingScale([...returns, minimumAcceptableReturn]);
  const excessMean = mean(
    returns.map((value) => value.rescale(scale)),
    scale
  ).sub(minimumAcceptableReturn.rescale(scale));
  return excessMean.div(deviation);
}

/**
 * Calmar ratio: annualized mean return divided by the maximum drawdown,
 * `mean(returns) * periodsPerYear / maxDrawdown(drawdown)`.
 *
 * The mean is annualized arithmetically (no compounding) so the whole
 * calculation stays in fixed point. `periodsPerYear` defaults to 1, which
 * gives a per-period ratio. The ratio keeps the sign of the mean return.
 *
 * Throws for an empty return series, a non-positive `periodsPerYear`, and a
 * zero maximum drawdown, which leaves nothing to divide by.
 */
export function calmarRatio(
  returns: readonly Decimal[],
  drawdown: readonly Decimal[],
  periodsPerYear: Decimal | number = 1
): Decimal {
  if (returns.length === 0) {
    throw new RangeError("calmarRatio needs at least one return");
  }
  const periods = toDecimalInput(periodsPerYear);
  if (!periods.isPositive()) {
    throw new RangeError("periodsPerYear must be positive");
  }
  const worst = maxDrawdown(drawdown);
  if (worst.isZero()) {
    throw new RangeError(
      "calmarRatio is undefined for a zero maximum drawdown"
    );
  }

  const scale = workingScale([...returns, periods, worst]);
  const annualMean = mean(
    returns.map((value) => value.rescale(scale)),
    scale
  ).mul(periods.rescale(scale));
  return annualMean.div(worst.rescale(scale));
}

/**
 * Most negative entry of the drawdown series, where each entry is the running
 * `value / peak - 1` decline. The result is reported as a non-negative
 * magnitude: the sign of the worst decline is flipped, so a series that never
 * leaves its running peak gives `0`. An empty series also gives `0`.
 */
export function maxDrawdown(drawdown: readonly Decimal[]): Decimal {
  const scale = workingScale(drawdown);
  let worst = Decimal.zero(scale);
  for (const value of drawdown) {
    if (value.lt(worst)) {
      worst = value.rescale(scale);
    }
  }
  return worst.neg();
}

/**
 * Computes every metric from the collector's series in one call.
 *
 * `sortinoRatio` and `calmarRatio` come back as `null` when their denominator
 * is zero, instead of throwing, so a run with no losing step still reports
 * the rest. `periodsPerYear` only scales Calmar; it defaults to 1.
 */
export function computeRiskMetrics(
  drawdown: readonly Decimal[],
  returns: readonly Decimal[],
  options: {
    riskFreePerPeriod?: Decimal;
    varianceMode?: VarianceMode;
    confidenceLevel?: Decimal | number;
    minimumAcceptableReturn?: Decimal;
    periodsPerYear?: Decimal | number;
  } = {}
): RiskMetrics {
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const minimumAcceptableReturn =
    options.minimumAcceptableReturn ?? Decimal.zero();
  const worst = maxDrawdown(drawdown);
  // Sharpe and VaR run first so their documented errors keep precedence.
  const sharpe = sharpeRatio(
    returns,
    options.riskFreePerPeriod ?? Decimal.zero(),
    options.varianceMode ?? "population"
  );
  const valueAtRiskResult = valueAtRisk(returns, confidenceLevel);
  const deviation = downsideDeviation(returns, minimumAcceptableReturn);

  return {
    maxDrawdown: worst,
    sharpeRatio: sharpe,
    valueAtRisk: valueAtRiskResult,
    conditionalValueAtRisk: conditionalValueAtRisk(returns, confidenceLevel),
    downsideDeviation: deviation,
    sortinoRatio: deviation.isZero()
      ? null
      : sortinoRatio(returns, minimumAcceptableReturn),
    calmarRatio: worst.isZero()
      ? null
      : calmarRatio(returns, drawdown, options.periodsPerYear ?? 1),
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
export function decimalSqrt(value: Decimal): Decimal {
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
