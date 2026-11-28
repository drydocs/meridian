import { useTranslation } from "react-i18next";
import type { ApiPosition } from "../../lib/api";
import { formatUsd } from "../../lib/format";

interface PositionSummaryProps {
  position: ApiPosition;
  lastUpdated?: number;
  isStale?: boolean;
}

function formatLastUpdated(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function PositionSummary({
  position,
  lastUpdated,
  isStale = false,
}: PositionSummaryProps) {
  const { t, i18n } = useTranslation();

  return (
    <div className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1">
            {t("vaultPanel.yourPosition")}
          </p>
          <p className="text-base font-bold text-paper">
            {formatUsd(position.deposited, i18n.language)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 mb-1">{t("vaultPanel.earned")}</p>
          <p className="text-base font-bold text-emerald-400">
            +{formatUsd(position.earned, i18n.language)}
          </p>
        </div>
      </div>
      {(lastUpdated !== undefined || isStale) && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500">
          {isStale && (
            <span className="rounded-full border border-amber-700 bg-amber-900/40 px-2 py-0.5 text-amber-300">
              {t("status.stale")}
            </span>
          )}
          {lastUpdated !== undefined && (
            <span>
              {t("status.lastUpdated")}{" "}
              {formatLastUpdated(lastUpdated, i18n.language)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
