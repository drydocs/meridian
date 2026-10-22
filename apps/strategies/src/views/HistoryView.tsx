export function HistoryView() {
  return (
    <div className="view" data-testid="view-history">
      <div className="view__header">
        <h2 className="view__title">Run History</h2>
        <p className="view__description">
          Review previous simulation runs, generated reports, and risk
          parameters.
        </p>
      </div>
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
          summaries, drawdown curves, and serialized reports.
        </p>
      </div>
    </div>
  );
}
