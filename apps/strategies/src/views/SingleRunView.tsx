import type { RunRecord } from "../lib/run-history";

interface SingleRunViewProps {
  readonly run: RunRecord | null;
}

export function SingleRunView({ run }: SingleRunViewProps) {
  return (
    <div className="view" data-testid="view-single-run">
      <div className="view__header">
        <h2 className="view__title">Single Run</h2>
        <p className="view__description">
          Configure strategy parameters and scenario models to simulate a single
          execution path.
        </p>
      </div>
      {run === null ? (
        <div className="empty-state" data-testid="empty-single-run">
          <div className="empty-state__icon" aria-hidden="true">
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"
              />
            </svg>
          </div>
          <h3 className="empty-state__title">No simulation running</h3>
          <p className="empty-state__body">
            Simulation controls and scenario parameters land in a later issue.
            When configured, backtests and projected metrics will appear here.
          </p>
        </div>
      ) : (
        <section className="run-result" data-testid="single-run-result">
          <div className="run-result__header">
            <div>
              <h3 className="run-result__title">{run.scenario.strategy.id}</h3>
              <p className="run-result__subtitle">
                {run.scenario.window.start} to {run.scenario.window.end}
              </p>
            </div>
            <time dateTime={new Date(run.createdAt).toISOString()}>
              {new Date(run.createdAt).toLocaleString()}
            </time>
          </div>
          <dl className="run-result__metrics">
            <div>
              <dt>Final value</dt>
              <dd>{run.result.finalValue.toString()}</dd>
            </div>
            <div>
              <dt>PnL</dt>
              <dd>
                {run.result.strategyEquity
                  .sub(run.result.initialCash)
                  .toString()}
              </dd>
            </div>
            <div>
              <dt>Maximum drawdown</dt>
              <dd>{run.riskMetrics.maxDrawdown.toString()}</dd>
            </div>
            <div>
              <dt>Sharpe ratio</dt>
              <dd>
                {run.riskMetrics.sharpeRatio?.toString() ?? "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Value at risk</dt>
              <dd>
                {run.riskMetrics.valueAtRisk?.toString() ?? "Unavailable"}
              </dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
