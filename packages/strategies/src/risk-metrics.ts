import { Decimal } from "./decimal";

/**
 * Risk metrics computed from the metrics collector's series
 * ([SDK] Add risk metrics (VaR, Sharpe, max drawdown), #881).
 *
 * ─── Maximum drawdown ────────────────────────────────────────────────────
 * Input: `drawdown` — the collector's running drawdown series, the
 * non-positive fractional loss from the running peak: at each tick,
 * `drawdown_t = value_t / peak_t - 1 <= 0`. The maximum drawdown is the most
 * negative entry of that series, i.e. the largest peak-to-trough decline the
 * strategy ever showed:
 *
 *     maxDrawdown = min_t(drawdown_t)          (elementwise minimum)
 *
 * A series that never leaves its running peak (or is empty) has a maximum
 * drawdown of exactly 0. Ties resolve to the first (earliest) occurrence.
 *
 * ─── Sharpe ratio ────────────────────────────────────────────────────────
 * Input: `returns` — the collector's per-period simple returns
 * (`value_t / value_{t-1} - 1`). The Sharpe ratio is the mean excess return
 * divided by the population standard deviation of returns:
 *
 *     sharpe = (mean(returns) - riskFreePerPeriod)
 *              / stdev(returns, "population")
 *
 * Conventions, applied consistently across this module:
 * - `riskFreePerPeriod` is the risk-free rate **per period** and is subtracted
 *   from every return (excess-return form). Callers holding an annual rate
 *   must convert it themselves; `annualizeSharpe` documents one way.
 * - Dispersion uses the **population** (n-denominator) second central moment,
 *   matching the classic backtest convention for a fixed finite sample. Pass
 *   `varianceMode: "sample"` to switch to the unbiased (n−1) denominator —
 *   the ratio then changes by exactly sqrt(n / (n - 1)).
 * - **Annualization**: `sharpe` returns the per-period ratio. Annualizing
 *   scales by sqrt(periodsPerYear), the convention for i.i.d. returns with
 *   independent periods; use `annualizeSharpe(sharpe, periodsPerYear)`.
 *   Common values: 365 for daily stablecoin-vault series (crypto markets
 *   trade every day), 52 weekly, 12 monthly.
 *
 * A single return has zero population variance, which would make the ratio
 * meaningless, so `sharpe` throws for fewer than two returns and for an
 * all-identical return series (undefined division by a zero deviation).
 *
 * ─── Historical value at risk ────────────────────────────────────────────
 * Input: `returns` — the same per-period simple return series. The
 * historical VaR at confidence `c` (e.g. 0.95) is the empirical loss threshold
 * that is breached only `(1 - c)` of the time. Convention:
 *
 * - With n returns and `k = (1 - c) * n`, the VaR is the **k-th smallest
 *   return** in sorted order (1-indexed), i.e. the elementwise
 *   lower-tail quantile. Returned as a **non-negative loss**, so
 *   `var > 0` means "you could lose up to `var` of value with probability
 *   `(1 - c)` per period"; a positive k-th smallest return yields a
 *   negative VaR, reporting a gain threshold.
 * - k = ceil((1 - c) * n), so at 95% confidence with 100 returns the VaR is
 *   the 5th smallest return; with 20 returns the 1st smallest. k is clamped
 *   into [1, n].
 * - The sort is numeric and ascending on the exact raw numerators, so the
 *   quantile reproduces the expected order statistic exactly.
 */
export interface RiskMetrics {
  /** Most negative entry of the drawdown series (≤ 0), exact for empty series. */
  readonly maxDrawdown: Decimal;
  /** Per-period Sharpe ratio, population variance; annualize via annualizeSharpe. */
  readonly sharpeRatio: Decimal;
  /** Non-positive-tail loss quantile; negative values signal a gain threshold. */
  readonly valueAtRisk: Decimal;
}

export type VarianceMode = "population" | "sample";

/** Confidence level of exactly 0 or 1 is rejected as degenerate. */
const CONFIDENCE_ONE_RAW = Decimal.one().toRaw();

/** Per-period Sharpe ratio from simple per-period returns, per the header notes. */
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
  const mean = Decimal.mean(returns);
  const excessMean = mean.sub(riskFreePerPeriod);

  let sumSquaredDeviations = 0n;
  for (const value of returns) {
    const deviation = value.sub(mean);
    sumSquaredDeviations += deviation.mul(deviation).toRaw();
  }
  const divisor =
    varianceMode === "population"
      ? BigInt(returns.length)
      : BigInt(returns.length - 1);
  const variance = Decimal.fromRaw(halfUpDivide(sumSquaredDeviations, divisor));
  if (variance.isZero()) {
    throw new RangeError(
      "sharpeRatio is undefined for a zero-variance return series"
    );
  }
  return excessMean.div(variance.sqrt());
}

/** Scales a per-period Sharpe ratio to a yearly one by sqrt(periodsPerYear). */
export function annualizeSharpe(
  perPeriod: Decimal,
  periodsPerYear: Decimal | number
): Decimal {
  const periods =
    typeof periodsPerYear === "number"
      ? Decimal.fromDecimalString(String(periodsPerYear))
      : periodsPerYear;
  if (!periods.isPositive()) {
    throw new RangeError("periodsPerYear must be positive");
  }
  return perPeriod.mul(periods.sqrt());
}

/**
 * Historical value at risk: the k-th smallest return, k = ceil((1 - c) * n),
 * reported as a non-negative loss per the header convention.
 */
export function valueAtRisk(
  returns: readonly Decimal[],
  confidenceLevel: Decimal | number
): Decimal {
  const confidence =
    typeof confidenceLevel === "number"
      ? Decimal.fromDecimalString(String(confidenceLevel))
      : confidenceLevel;
  const confidenceRaw = confidence.toRaw();
  if (confidenceRaw <= 0n || confidenceRaw >= CONFIDENCE_ONE_RAW) {
    throw new RangeError("confidenceLevel must be strictly between 0 and 1");
  }
  if (returns.length === 0) {
    throw new RangeError("valueAtRisk needs at least one return");
  }
  const sorted = [...returns].sort((a, b) => a.compare(b));
  const rank = ceilOf(
    Decimal.one()
      .sub(confidence)
      .mul(Decimal.fromRaw(BigInt(sorted.length)))
  );
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

/** Maximum drawdown: the most negative entry of the drawdown series. */
export function maxDrawdown(drawdown: readonly Decimal[]): Decimal {
  let worst = Decimal.zero();
  for (const value of drawdown) {
    if (value.compare(worst) < 0) {
      worst = value;
    }
  }
  return worst;
}

/** Convenience wrapper computing all three metrics from the collector's series. */
export function computeRiskMetrics(
  drawdown: readonly Decimal[],
  returns: readonly Decimal[],
  options: {
    riskFreePerPeriod?: Decimal;
    varianceMode?: VarianceMode;
    confidenceLevel?: Decimal | number;
  } = {}
): RiskMetrics {
  const sharpe = sharpeRatio(
    returns,
    options.riskFreePerPeriod ?? Decimal.zero(),
    options.varianceMode ?? "population"
  );
  return {
    maxDrawdown: maxDrawdown(drawdown),
    sharpeRatio: sharpe,
    valueAtRisk: valueAtRisk(returns, options.confidenceLevel ?? 0.95),
  };
}

/** ceil(raw / 10^18) for a scale-18 value; negative raws ceil toward +inf. */
function ceilOf(value: Decimal): bigint {
  const raw = value.toRaw();
  const quotient = raw / RAW_SCALE;
  if (raw % RAW_SCALE === 0n || raw < 0n) {
    return quotient;
  }
  return quotient + 1n;
}

const RAW_SCALE = 10n ** 18n;

/** Half-up bigint division; used once, for the variance mean of squares. */
function halfUpDivide(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const numeratorAbs = numerator < 0n ? -numerator : numerator;
  const denominatorAbs = denominator < 0n ? -denominator : denominator;
  const quotient = numeratorAbs / denominatorAbs;
  const remainder = numeratorAbs % denominatorAbs;
  const rounded = 2n * remainder >= denominatorAbs ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}
