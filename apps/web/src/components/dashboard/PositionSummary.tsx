import { useTranslation } from "react-i18next";
import type { ApiPosition, ApiVault } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";

interface PositionSummaryProps {
  position: ApiPosition;
  vault?: ApiVault;
}

export function PositionSummary({ position, vault }: PositionSummaryProps) {
  const { t, i18n } = useTranslation();

  return (
    <div
      data-testid={`position-${position.vaultId}`}
      className="mx-7 my-5 rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3.5"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-gray-400 mb-1">
            {t("vaultPanel.yourPosition")}
          </p>
          <p className="text-sm font-semibold text-paper">
            {vault?.name ?? position.vaultId}
          </p>
          {vault && (
            <p className="text-xs text-gray-400">
              {vault.label} · {PROTOCOL_LABEL[vault.protocol] ?? vault.protocol}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-400 mb-1">
            {t("positionPnl.currentValue")}
          </p>
          <p className="text-base font-bold text-paper">
            {formatUsd(position.deposited, i18n.language)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-400 mb-1">{t("vaultPanel.earned")}</p>
          <p className="text-base font-bold text-emerald-400">
            +{formatUsd(position.earned, i18n.language)}
          </p>
        </div>
      </div>
    </div>
  );
}
