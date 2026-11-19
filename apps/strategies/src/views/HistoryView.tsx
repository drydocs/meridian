import type { RunRecord } from "../lib/run-history";

interface HistoryViewProps {
  readonly records: readonly RunRecord[];
  readonly selectedRunIds: readonly string[];
  readonly notice: string | null;
  readonly error: string | null;
  readonly onOpenRun: (record: RunRecord) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onDeleteRun: (id: string) => void;
  readonly onClearHistory: () => void;
}

function formatWindow(record: RunRecord): string {
  const { start, end } = record.scenario.window;
  return `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}`;
}

function formatRunTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function HistoryView({
  records,
  selectedRunIds,
  notice,
  error,
  onOpenRun,
  onToggleSelection,
  onDeleteRun,
  onClearHistory,
}: HistoryViewProps) {
  return (
    <div className="view" data-testid="view-history">
      <div className="view__header history__header">
        <div>
          <h2 className="view__title">Run History</h2>
          <p className="view__description">
            Review saved simulation runs or select runs to compare.
          </p>
        </div>
        {records.length > 0 && (
          <button
            type="button"
            className="history__clear"
            onClick={onClearHistory}
          >
            Clear history
          </button>
        )}
      </div>

      {notice !== null && (
        <p
          className="history__message"
          role="status"
          data-testid="history-notice"
        >
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="history__message history__message--error" role="alert">
          Run history could not be updated: {error}
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
            Completed simulation runs will appear here with their performance
            summaries.
          </p>
        </div>
      ) : (
        <>
          <p className="history__selection">
            {selectedRunIds.length} selected for comparison
          </p>
          <ul className="history-list">
            {records.map((record) => {
              const isSelected = selectedRunIds.includes(record.id);
              const pnl = record.result.strategyEquity.sub(
                record.result.initialCash
              );
              return (
                <li className="history-card" key={record.id}>
                  <div className="history-card__summary">
                    <h3 className="history-card__title">
                      {record.scenario.strategy.id}
                    </h3>
                    <span className="history-card__window">
                      {formatWindow(record)}
                    </span>
                  </div>
                  <dl className="history-card__metrics">
                    <div>
                      <dt>Final value</dt>
                      <dd>{record.result.finalValue.toString()}</dd>
                    </div>
                    <div>
                      <dt>PnL</dt>
                      <dd>{pnl.toString()}</dd>
                    </div>
                    <div>
                      <dt>Run time</dt>
                      <dd>{formatRunTime(record.createdAt)}</dd>
                    </div>
                  </dl>
                  <div className="history-card__actions">
                    <button
                      type="button"
                      onClick={() => onOpenRun(record)}
                      data-testid={`open-run-${record.id}`}
                    >
                      Open run
                    </button>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onToggleSelection(record.id)}
                      data-testid={`select-run-${record.id}`}
                    >
                      {isSelected
                        ? "Remove from comparison"
                        : "Select for comparison"}
                    </button>
                    <button
                      type="button"
                      className="history-card__delete"
                      onClick={() => onDeleteRun(record.id)}
                      data-testid={`delete-run-${record.id}`}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
