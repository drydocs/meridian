import { useMemo } from "react";
import type { Decimal } from "@meridian/strategies";
import {
  DEFAULT_CONFIDENCE_LEVEL,
  summarizeRiskMetrics,
} from "../lib/risk-series";
import type {
  InsufficientDataReason,
  InvalidInputReason,
  MetricResult,
  RiskSnapshot,
} from "../lib/risk-series";

export interface RiskMetricsPanelProps {
  /** A completed run's snapshots, e.g. `runBacktest(...).snapshots`. */
  readonly snapshots: readonly RiskSnapshot[];
  /** The scenario's `window.step`, an ISO-8601 duration such as `P1D`. */
  readonly step: string;
  /** Value-at-risk confidence, strictly between 0 and 1. Defaults to 0.95. */
  readonly confidenceLevel?: number;
}

const INSUFFICIENT_MESSAGES: Record<InsufficientDataReason, string> = {
  "too-few-returns":
    "Needs at least two per-step returns, so a run with three or more snapshots.",
  "zero-variance":
    "Every per-step return is identical, so there is no dispersion to divide by.",
  "empty-drawdown": "The run has no snapshots to measure a drawdown from.",
  "zero-downside-deviation":
    "No per-step return fell below 0%, so there is no downside deviation to divide by.",
  "zero-drawdown":
    "The value never fell below an earlier peak, so there is no drawdown to divide by.",
};

const INVALID_MESSAGES: Record<InvalidInputReason, string> = {
  "invalid-step":
    "The scenario step is not an ISO-8601 duration the engine accepts, so returns cannot be annualized.",
  "invalid-confidence":
    "The confidence level must be a decimal strictly between 0 and 1.",
  "non-positive-value":
    "The portfolio value reached zero or below before the last snapshot, so per-step returns are undefined.",
};

function percent(value: Decimal): string {
  return `${value.mul("100").toFixed(2)}%`;
}

function trimmed(value: Decimal, places: number): string {
  return value.toFixed(places).replace(/\.?0+$/, "");
}

interface MetricCardProps {
  readonly id: string;
  readonly label: string;
  readonly result: MetricResult;
  readonly format: (value: Decimal) => string;
  readonly convention: string;
  readonly explanation: string;
  readonly formula: string;
}

function MetricCard({
  id,
  label,
  result,
  format,
  convention,
  explanation,
  formula,
}: MetricCardProps) {
  const labelId = `risk-metric-${id}-label`;
  return (
    <article
      className="risk-metric"
      aria-labelledby={labelId}
      data-testid={`risk-metric-${id}`}
    >
      <h4 className="risk-metric__label" id={labelId}>
        {label}
      </h4>
      {result.status === "ok" ? (
        <p
          className="risk-metric__value"
          data-testid={`risk-metric-${id}-value`}
        >
          {format(result.value)}
        </p>
      ) : (
        <div
          className="risk-metric__insufficient"
          data-testid={`risk-metric-${id}-insufficient`}
        >
          <p className="risk-metric__value risk-metric__value--empty">
            Not enough data
          </p>
          <p className="risk-metric__reason">
            {INSUFFICIENT_MESSAGES[result.reason]}
          </p>
        </div>
      )}
      <p className="risk-metric__convention">{convention}</p>
      <p className="risk-metric__explanation">{explanation}</p>
      <code className="risk-metric__formula">{formula}</code>
    </article>
  );
}

/**
 * Shows the engine's max drawdown, annualized Sharpe and Sortino ratios,
 * Calmar ratio, value at risk and conditional value at risk for one completed
 * run. Read-only: it derives the series from the snapshots
 * it is given and never fetches or changes the run.
 */
export function RiskMetricsPanel({
  snapshots,
  step,
  confidenceLevel = DEFAULT_CONFIDENCE_LEVEL,
}: RiskMetricsPanelProps) {
  const summary = useMemo(
    () => summarizeRiskMetrics({ snapshots, step, confidenceLevel }),
    [snapshots, step, confidenceLevel]
  );

  if (summary.kind === "invalid") {
    return (
      <section
        className="risk-panel"
        aria-labelledby="risk-panel-title"
        data-testid="risk-metrics-panel"
      >
        <div className="risk-panel__header">
          <h3 className="risk-panel__title" id="risk-panel-title">
            Risk metrics
          </h3>
        </div>
        <p className="risk-panel__notice" data-testid="risk-metrics-invalid">
          {INVALID_MESSAGES[summary.reason]}
        </p>
      </section>
    );
  }

  const confidence = `${trimmed(summary.confidenceLevel.mul("100"), 4)}%`;
  const tail = `${trimmed(summary.confidenceLevel.neg().add("1").mul("100"), 4)}%`;
  const periods = trimmed(summary.periodsPerYear, 2);

  return (
    <section
      className="risk-panel"
      aria-labelledby="risk-panel-title"
      data-testid="risk-metrics-panel"
    >
      <div className="risk-panel__header">
        <h3 className="risk-panel__title" id="risk-panel-title">
          Risk metrics
        </h3>
        <p className="risk-panel__description">
          Computed by the strategy engine from {summary.returnCount} per-step{" "}
          {summary.returnCount === 1 ? "return" : "returns"} between the
          run&apos;s snapshots. Step {step}, {periods} periods per 365-day year.
        </p>
      </div>
      <div className="risk-panel__grid">
        <MetricCard
          id="max-drawdown"
          label="Maximum drawdown"
          result={summary.maxDrawdown}
          format={percent}
          convention="Percent of the running peak value, quoted as a positive loss. 0% means the value never fell below an earlier peak."
          explanation="The deepest fall from an earlier high at any point in the run, whether or not it later recovered."
          formula="MDD = max over t of (1 - V[t] / peak[t]), peak[t] = max V[s] for s <= t"
        />
        <MetricCard
          id="sharpe"
          label="Sharpe ratio (annualized)"
          result={summary.annualizedSharpe}
          format={(value) => value.toFixed(2)}
          convention={`Unitless, annualized over ${periods} periods per year with a 0% risk-free rate. Positive means the average step return was above zero.`}
          explanation="Average return per unit of volatility. Higher is better; it compares how much return the run earned for the swings it took."
          formula="Sharpe = mean(r) / stdev(r) x sqrt(periods per year), r[t] = V[t] / V[t-1] - 1, population stdev"
        />
        <MetricCard
          id="var"
          label={`Value at risk (${confidence})`}
          result={summary.valueAtRisk}
          format={percent}
          convention={`Percent of value lost over one ${step} step, quoted as a positive loss. A negative value means even the worst ${tail} of steps was a gain.`}
          explanation={`Historical value at risk: in ${confidence} of steps the loss was no larger than this.`}
          formula="VaR = -r(k), the k-th smallest step return, k = ceil((1 - confidence) x n)"
        />
        <MetricCard
          id="cvar"
          label={`Conditional VaR (${confidence})`}
          result={summary.conditionalValueAtRisk}
          format={percent}
          convention={`Percent of value lost over one ${step} step, quoted as a positive loss. Never smaller than the value at risk.`}
          explanation={`Expected shortfall: the average loss across the worst ${tail} of steps, so rare large losses are not hidden behind the VaR cut-off.`}
          formula="CVaR = -mean(r[i] for r[i] <= r(k)), the same k as VaR"
        />
        <MetricCard
          id="sortino"
          label="Sortino ratio (annualized)"
          result={summary.annualizedSortino}
          format={(value) => value.toFixed(2)}
          convention={`Unitless, annualized over ${periods} periods per year with a 0% minimum acceptable return.`}
          explanation="Like Sharpe, but only steps below 0% count as risk, so upside swings are not penalized."
          formula="Sortino = mean(r) / DD x sqrt(periods per year), DD = sqrt(sum(min(0, r[t])^2) / n)"
        />
        <MetricCard
          id="calmar"
          label="Calmar ratio"
          result={summary.calmarRatio}
          format={(value) => value.toFixed(2)}
          convention={`Unitless. Mean step return annualized arithmetically over ${periods} periods per year, divided by the maximum drawdown.`}
          explanation="Yearly return earned per unit of the deepest drawdown. Higher means more return for the deepest fall the run took."
          formula="Calmar = mean(r) x periods per year / MDD"
        />
      </div>
    </section>
  );
}
