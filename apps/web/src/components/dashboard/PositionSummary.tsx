import { useTranslation } from "react-i18next";
import type { ApiPosition } from "../../lib/api";
import { formatUsd } from "../../lib/format";

interface PositionSummaryProps {
  position: ApiPosition;
}

export function PositionSummary({ position }: PositionSummaryProps) {
  const { t, i18n } = useTranslation();

  return (
    <div className="mx-4 my-5 flex flex-col gap-2 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5 sm:mx-7 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs text-gray-400 mb-1">
          {t("vaultPanel.yourPosition")}
        </p>
        <p className="break-words text-sm font-bold text-paper sm:text-base">
          {formatUsd(position.deposited, i18n.language)}
        </p>
      </div>
      <div className="min-w-0 sm:text-right">
        <p className="text-xs text-gray-400 mb-1">{t("vaultPanel.earned")}</p>
        <p className="break-words text-sm font-bold text-emerald-400 sm:text-base">
          +{formatUsd(position.earned, i18n.language)}
        </p>
      </div>
    </div>
  );
}
