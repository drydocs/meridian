import { formatDecimal } from "../lib/format";
import type { RunRecord } from "../lib/run-history";

interface HistoryViewProps {
  readonly records: readonly RunRecord[];
  readonly droppedRecords: boolean;
  readonly selectedRunIds: ReadonlySet<string>;
  readonly onOpenRun: (record: RunRecord) => void;
  readonly onDeleteRun: (id: string) => void;
  readonly onClearHistory: () => void;
  readonly onToggleComparison: (id: string) => void;
}

export function HistoryView({
  records,
  droppedRecords,
  selectedRunIds,
  onOpenRun,
  onDeleteRun,
  onClearHistory,
  onToggleComparison,
}: HistoryViewProps) {
  return (
    <div className="view" data-testid="view-history">
      <div className="view__header">
        <h2 className="view__title">Run History</h2>
        <p className="view__description">
          Review previous simulation runs, generated reports, and risk
          parameters.
        </p>
      </div>
      {droppedRecords && (
        <p
          className="history-notice"
          role="status"
          data-testid="history-notice"
        >
          Some saved runs could not be read and were skipped. They stay in
          browser storage, and the remaining history is available below.
        </p>
      )}
      {records.length === 0 ? (
        <div className="empty-state" data-testid="empty-history">
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
                d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
              />
            </svg>
          </div>
          <h3 className="empty-state__title">No past runs recorded</h3>
          <p className="empty-state__body">
            Completed simulation runs will be listed here with performance
            summaries, drawdown curves, and risk metrics.
          </p>
        </div>
      ) : (
        <section className="panel history" aria-label="Saved runs">
          <div className="history__header">
            <p className="history__count">
              {records.length} saved {records.length === 1 ? "run" : "runs"}
            </p>
            <button
              type="button"
              className="button button--danger"
              onClick={onClearHistory}
              data-testid="clear-history"
            >
              Clear all
            </button>
          </div>
          <div className="history__list">
            {records.map((record) => {
              const pnl = record.result.strategyEquity.sub(
                record.result.initialCash
              );
              const isSelected = selectedRunIds.has(record.id);
              return (
                <article
                  className="history-run"
                  key={record.id}
                  data-testid="history-run"
                >
                  <div className="history-run__details">
                    <h3 className="history-run__title">
                      {record.scenario.strategy.id}@
                      {record.scenario.strategy.version}
                    </h3>
                    <p className="history-run__window">
                      {record.scenario.window.start} to{" "}
                      {record.scenario.window.end}
                    </p>
                    <p className="history-run__time">
                      Run {new Date(record.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <dl className="history-run__metrics">
                    <div>
                      <dt>Final value</dt>
                      <dd>
                        {formatDecimal(record.result.finalValue.toString())}
                      </dd>
                    </div>
                    <div>
                      <dt>PnL</dt>
                      <dd>{formatDecimal(pnl.toString())}</dd>
                    </div>
                  </dl>
                  <div className="history-run__actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => onOpenRun(record)}
                      data-testid={`open-run-${record.id}`}
                    >
                      Open run
                    </button>
                    <label className="history-run__select">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleComparison(record.id)}
                        data-testid={`compare-run-${record.id}`}
                      />
                      Compare
                    </label>
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => onDeleteRun(record.id)}
                      aria-label={`Delete ${record.scenario.strategy.id} run`}
                      data-testid={`delete-run-${record.id}`}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
