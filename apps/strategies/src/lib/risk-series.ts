import {
  Decimal,
  annualizeSharpe,
  calmarRatio,
  computeRiskMetrics,
  conditionalValueAtRisk,
  downsideDeviation,
  durationToMilliseconds,
  maxDrawdown,
  sortinoRatio,
  valueAtRisk,
} from "@meridian/strategies";
import type { BacktestSnapshot, RiskMetrics } from "@meridian/strategies";

/**
 * Matches the engine's metrics scale, so a derived return is not rounded
 * more coarsely than `computeRiskMetrics` itself works.
 */
export const SERIES_SCALE = 18;

/** The engine accrues annual rates over a 365-day year, so Sharpe does too. */
export const YEAR_MS = 365 * 86_400_000;

/** `computeRiskMetrics` uses the same default when no level is given. */
export const DEFAULT_CONFIDENCE_LEVEL = 0.95;

/** Only the marked value is read, so callers can pass `result.snapshots`. */
export type RiskSnapshot = Pick<BacktestSnapshot, "value">;

export interface RiskSeries {
  /** Simple per-step returns `V[t] / V[t-1] - 1`, one per snapshot after the first. */
  readonly returns: readonly Decimal[];
  /** Running `V[t] / peak[t] - 1`, one per snapshot, 0 or lower. */
  readonly drawdown: readonly Decimal[];
}

function valueOf(snapshot: RiskSnapshot): Decimal {
  return Decimal.fromStroops(snapshot.value.toStroops()).rescale(SERIES_SCALE);
}

function requirePositive(value: Decimal, what: string): void {
  if (!value.isPositive()) {
    throw new RangeError(`${what} must be positive, received ${value}`);
  }
}

/**
 * Per-step simple returns between consecutive snapshots, the series
 * `sharpeRatio` and `valueAtRisk` read. Throws a RangeError when a value that
 * a later return divides by is zero or negative.
 */
export function deriveReturnSeries(
  snapshots: readonly RiskSnapshot[]
): Decimal[] {
  const one = Decimal.one(SERIES_SCALE);
  const returns: Decimal[] = [];
  let previous: Decimal | undefined;
  for (const snapshot of snapshots) {
    const current = valueOf(snapshot);
    if (previous !== undefined) {
      requirePositive(previous, "A value a return divides by");
      returns.push(current.div(previous).sub(one));
    }
    previous = current;
  }
  return returns;
}

/**
 * Running drawdown in the shape `maxDrawdown` expects: each entry is
 * `value / runningPeak - 1`, so it is 0 at a new peak and negative below one.
 * Throws a RangeError when the first value, and so the opening peak, is not
 * positive.
 */
export function deriveDrawdownSeries(
  snapshots: readonly RiskSnapshot[]
): Decimal[] {
  const one = Decimal.one(SERIES_SCALE);
  const drawdown: Decimal[] = [];
  let peak: Decimal | undefined;
  for (const snapshot of snapshots) {
    const current = valueOf(snapshot);
    if (peak === undefined) {
      requirePositive(current, "The opening value");
      peak = current;
    } else if (current.gt(peak)) {
      peak = current;
    }
    drawdown.push(current.div(peak).sub(one));
  }
  return drawdown;
}

export function deriveRiskSeries(
  snapshots: readonly RiskSnapshot[]
): RiskSeries {
  return {
    returns: deriveReturnSeries(snapshots),
    drawdown: deriveDrawdownSeries(snapshots),
  };
}

/**
 * Steps per 365-day year for an ISO-8601 scenario step (`P1D` gives 365,
 * `PT1H` 8760, `P1W` 52.142857...). Throws for a step the scenario schema
 * would reject.
 */
export function periodsPerYear(step: string): Decimal {
  const stepMs = durationToMilliseconds(step);
  if (!Number.isSafeInteger(stepMs) || stepMs <= 0) {
    throw new RangeError(`step must be a positive duration, received ${step}`);
  }
  return Decimal.fromBigInt(BigInt(YEAR_MS), 0)
    .rescale(SERIES_SCALE)
    .div(Decimal.fromBigInt(BigInt(stepMs), 0));
}

export type InsufficientDataReason =
  | "too-few-returns"
  | "zero-variance"
  | "empty-drawdown"
  | "zero-downside-deviation"
  | "zero-drawdown";

export type MetricResult =
  | { readonly status: "ok"; readonly value: Decimal }
  | {
      readonly status: "insufficient";
      readonly reason: InsufficientDataReason;
    };

export type InvalidInputReason =
  "invalid-step" | "invalid-confidence" | "non-positive-value";

export type RiskMetricsSummary =
  | { readonly kind: "invalid"; readonly reason: InvalidInputReason }
  | {
      readonly kind: "computed";
      readonly returnCount: number;
      readonly periodsPerYear: Decimal;
      readonly confidenceLevel: Decimal;
      /** Non-negative loss magnitude as a ratio of the running peak. */
      readonly maxDrawdown: MetricResult;
      /** Per-period Sharpe scaled by `sqrt(periodsPerYear)`, risk-free rate 0. */
      readonly annualizedSharpe: MetricResult;
      /** One-step loss magnitude as a ratio of value; negative is a gain. */
      readonly valueAtRisk: MetricResult;
      /** Mean one-step loss in the VaR tail; same sign convention as VaR. */
      readonly conditionalValueAtRisk: MetricResult;
      /** Per-period Sortino scaled by `sqrt(periodsPerYear)`, MAR 0. */
      readonly annualizedSortino: MetricResult;
      /** Mean step return times `periodsPerYear`, over max drawdown. */
      readonly calmarRatio: MetricResult;
    };

export interface RiskMetricsInput {
  readonly snapshots: readonly RiskSnapshot[];
  /** The scenario's `window.step`, an ISO-8601 duration such as `P1D`. */
  readonly step: string;
  /** Strictly between 0 and 1. Defaults to {@link DEFAULT_CONFIDENCE_LEVEL}. */
  readonly confidenceLevel?: number;
}

function ok(value: Decimal): MetricResult {
  return { status: "ok", value };
}

function insufficient(reason: InsufficientDataReason): MetricResult {
  return { status: "insufficient", reason };
}

function parseConfidence(level: number): Decimal | undefined {
  if (!Number.isFinite(level)) return undefined;
  let confidence: Decimal;
  try {
    confidence = Decimal.fromString(String(level), SERIES_SCALE);
  } catch {
    // Exponent notation such as 1e-7 is not a decimal literal; reject it.
    return undefined;
  }
  return confidence.isPositive() && confidence.lt(Decimal.one())
    ? confidence
    : undefined;
}

/**
 * True when a value some return or drawdown entry divides by is not positive:
 * the opening value (the first peak) or any value before the last.
 */
function hasNonPositiveDivisor(snapshots: readonly RiskSnapshot[]): boolean {
  const last = snapshots.length - 1;
  return snapshots.some(
    (snapshot, index) =>
      (index === 0 || index < last) && snapshot.value.toStroops() <= 0n
  );
}

/**
 * Derives both series from a run's snapshots and hands them to the engine's
 * risk metrics. Never throws for run data: the engine's documented failure
 * cases come back as an `insufficient` metric, and inputs the engine cannot
 * read come back as `invalid`. The snapshots are only read.
 */
export function summarizeRiskMetrics(
  input: RiskMetricsInput
): RiskMetricsSummary {
  const confidence = parseConfidence(
    input.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL
  );
  if (confidence === undefined) {
    return { kind: "invalid", reason: "invalid-confidence" };
  }

  let periods: Decimal;
  try {
    periods = periodsPerYear(input.step);
  } catch {
    return { kind: "invalid", reason: "invalid-step" };
  }

  if (hasNonPositiveDivisor(input.snapshots)) {
    return { kind: "invalid", reason: "non-positive-value" };
  }

  const { returns, drawdown } = deriveRiskSeries(input.snapshots);
  const base = {
    kind: "computed" as const,
    returnCount: returns.length,
    periodsPerYear: periods,
    confidenceLevel: confidence,
  };

  if (returns.length < 2) {
    return {
      ...base,
      maxDrawdown:
        drawdown.length === 0
          ? insufficient("empty-drawdown")
          : ok(maxDrawdown(drawdown)),
      annualizedSharpe: insufficient("too-few-returns"),
      valueAtRisk: insufficient("too-few-returns"),
      conditionalValueAtRisk: insufficient("too-few-returns"),
      annualizedSortino: insufficient("too-few-returns"),
      calmarRatio: insufficient("too-few-returns"),
    };
  }

  let metrics: RiskMetrics;
  try {
    metrics = computeRiskMetrics(drawdown, returns, {
      confidenceLevel: confidence,
      periodsPerYear: periods,
    });
  } catch (error) {
    // With two or more returns and a validated confidence, the only RangeError
    // the engine documents is a zero variance. Checking that here instead
    // would be a second variance calculation, and could disagree with the
    // engine when returns differ by less than its rounding step.
    if (!(error instanceof RangeError)) throw error;
    return {
      ...base,
      maxDrawdown: ok(maxDrawdown(drawdown)),
      annualizedSharpe: insufficient("zero-variance"),
      valueAtRisk: ok(valueAtRisk(returns, confidence)),
      conditionalValueAtRisk: ok(conditionalValueAtRisk(returns, confidence)),
      ...downsideSummary(returns, drawdown, periods),
    };
  }

  return {
    ...base,
    maxDrawdown: ok(metrics.maxDrawdown),
    annualizedSharpe: ok(annualizeSharpe(metrics.sharpeRatio, periods)),
    valueAtRisk: ok(metrics.valueAtRisk),
    conditionalValueAtRisk: ok(metrics.conditionalValueAtRisk),
    annualizedSortino:
      metrics.sortinoRatio === null
        ? insufficient("zero-downside-deviation")
        : ok(annualizeSharpe(metrics.sortinoRatio, periods)),
    calmarRatio:
      metrics.calmarRatio === null
        ? insufficient("zero-drawdown")
        : ok(metrics.calmarRatio),
  };
}

/**
 * Sortino and Calmar for two or more returns, reporting a zero denominator
 * as `insufficient` rather than throwing. Used when Sharpe fails on a
 * zero-variance series, so the downside ratios are still shown.
 */
function downsideSummary(
  returns: readonly Decimal[],
  drawdown: readonly Decimal[],
  periods: Decimal
): Pick<
  Extract<RiskMetricsSummary, { kind: "computed" }>,
  "annualizedSortino" | "calmarRatio"
> {
  return {
    annualizedSortino: downsideDeviation(returns).isZero()
      ? insufficient("zero-downside-deviation")
      : ok(annualizeSharpe(sortinoRatio(returns), periods)),
    calmarRatio: maxDrawdown(drawdown).isZero()
      ? insufficient("zero-drawdown")
      : ok(calmarRatio(returns, drawdown, periods)),
  };
}
