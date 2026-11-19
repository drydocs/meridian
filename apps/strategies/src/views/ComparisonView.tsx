import type { RunRecord } from "../lib/run-history";

interface ComparisonViewProps {
  readonly runs: readonly RunRecord[];
}

export function ComparisonView({ runs }: ComparisonViewProps) {
  return (
    <div className="view" data-testid="view-comparison">
      <div className="view__header">
        <h2 className="view__title">Comparison</h2>
        <p className="view__description">
          Compare runs selected from run history.
        </p>
      </div>
      {runs.length === 0 ? (
        <div className="empty-state" data-testid="empty-comparison">
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
                d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
              />
            </svg>
          </div>
          <h3 className="empty-state__title">No runs to compare</h3>
          <p className="empty-state__body">
            Select completed simulation runs from history to compare their
            results.
          </p>
        </div>
      ) : (
        <ul className="comparison-list" data-testid="comparison-runs">
          {runs.map((run) => (
            <li className="comparison-card" key={run.id}>
              <h3>{run.scenario.strategy.id}</h3>
              <p>
                {run.scenario.window.start} to {run.scenario.window.end}
              </p>
              <dl className="comparison-card__metrics">
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
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
