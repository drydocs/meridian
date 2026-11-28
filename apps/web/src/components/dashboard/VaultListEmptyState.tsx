import { useTranslation } from "react-i18next";

export type VaultListEmptyStateKind = "no-vaults" | "failure";

export interface VaultListEmptyStateProps {
  /**
   * The kind of empty state to render:
   * - "no-vaults": server returned an empty vault array
   * - "failure": reading vaults failed (network or server error)
   */
  kind: VaultListEmptyStateKind;
  /**
   * Optional callback when user clicks the retry action on failure.
   */
  onRetry?: () => void;
  className?: string;
}

export function VaultListEmptyState({
  kind,
  onRetry,
  className = "",
}: VaultListEmptyStateProps) {
  const { t } = useTranslation();

  if (kind === "failure") {
    return (
      <div
        data-testid="vault-empty-failure"
        role="alert"
        className={`rounded-2xl border border-rose-800/60 bg-rose-950/20 px-6 py-8 text-center text-paper ${className}`}
      >
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-rose-900/40 text-rose-300">
          <svg
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h3 className="text-base font-semibold text-rose-200">
          {t("vaultPanel.emptyState.failureTitle", "Failed to load vaults")}
        </h3>
        <p className="mt-1 text-sm text-gray-400">
          {t(
            "vaultPanel.emptyState.failureDescription",
            "We couldn't retrieve the latest vault data. Check your network connection and try again."
          )}
        </p>
        {onRetry && (
          <div className="mt-5">
            <button
              type="button"
              onClick={onRetry}
              data-testid="vault-empty-retry-button"
              className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 transition-colors duration-150"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {t("common.retry", "Retry")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="vault-empty-none"
      className={`rounded-2xl border border-gray-800 bg-night-surface/60 px-6 py-8 text-center text-paper ${className}`}
    >
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-800/80 text-gray-400">
        <svg
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
          />
        </svg>
      </div>
      <h3 className="text-base font-semibold text-paper">
        {t("vaultPanel.emptyState.noVaultsTitle", "No vaults available")}
      </h3>
      <p className="mt-1 text-sm text-gray-400">
        {t(
          "vaultPanel.emptyState.noVaultsDescription",
          "There are currently no active vaults on this network. Please check back later."
        )}
      </p>
    </div>
  );
}
