export function SingleRunView() {
  return (
    <div className="view" data-testid="view-single-run">
      <div className="view__header">
        <h2 className="view__title">Single Run</h2>
        <p className="view__description">
          Configure strategy parameters and scenario models to simulate a single
          execution path.
        </p>
      </div>
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
    </div>
  );
}
