import { useTranslation } from "react-i18next";
import { APP_NETWORK } from "@meridian/shared";
import { useActivityStore, type LocalActivity } from "../../store/activity";
import { useWalletStore } from "../../store/wallet";
import { getTransactionExplorerUrl } from "../../lib/explorer";

interface ActivityHistoryProps {
  onRetry: (activity: LocalActivity) => void;
}

const statusClass = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  confirmed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-300",
};

export function ActivityHistory({ onRetry }: ActivityHistoryProps) {
  const { t, i18n } = useTranslation();
  const {
    activities: allActivities,
    latestReceipt,
    dismissReceipt,
  } = useActivityStore();
  const publicKey = useWalletStore((state) => state.publicKey);

  // The store is shared by every account used in this browser, so only the
  // connected wallet's own activity is shown.
  const activities = allActivities.filter(
    (item) => item.publicKey === publicKey
  );
  const receipt = latestReceipt?.publicKey === publicKey ? latestReceipt : null;

  function renderItem(activity: LocalActivity) {
    const explorerUrl = activity.transactionHash
      ? getTransactionExplorerUrl(APP_NETWORK.network, activity.transactionHash)
      : null;

    return (
      <div
        key={activity.id}
        data-testid="local-activity-item"
        className="rounded-xl border border-gray-800 bg-night px-4 py-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-paper">
              {t(`activity.actions.${activity.action}`)} {activity.amount}{" "}
              {activity.asset}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {activity.vaultName ?? activity.vaultId}
            </p>
          </div>
          <span
            className={`rounded-lg border px-2 py-1 text-xs ${statusClass[activity.status]}`}
          >
            {t(`activity.status.${activity.status}`)}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="truncate text-gray-600">
            {new Date(activity.timestamp).toLocaleString(i18n.language)}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            {activity.status === "failed" && (
              <button
                type="button"
                onClick={() => onRetry(activity)}
                className="text-amber-400 hover:text-amber-300"
              >
                {t("common.retry")}
              </button>
            )}
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300"
              >
                {t("activity.viewTx")}
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-7 pb-7 space-y-4">
      {receipt && (
        <div
          data-testid="action-receipt"
          className="rounded-xl border border-emerald-800/60 bg-emerald-950/20 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold text-emerald-300">
              {t("activity.receipt")}
            </h3>
            <button
              type="button"
              aria-label={t("activity.dismiss")}
              onClick={dismissReceipt}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              ×
            </button>
          </div>
          {renderItem(receipt)}
        </div>
      )}

      {activities.length > 0 && (
        <section aria-label={t("activity.title")}>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
            {t("activity.title")}
          </h3>
          <div className="space-y-2">{activities.map(renderItem)}</div>
        </section>
      )}
    </div>
  );
}
