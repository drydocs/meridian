import { useVaults } from "../../hooks/useVaults";
import { usePositions } from "../../hooks/usePositions";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { PositionSummary } from "./PositionSummary";
import { YieldHistoryChart } from "./YieldHistoryChart";
import { RiskDisclosureModal } from "../onboarding/RiskDisclosureModal";
import { useTranslation } from "react-i18next";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";

function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function VaultPanel() {
  const { data, isLoading: vaultsLoading } = useVaults();
  const vaults = data?.vaults;
  const { t } = useTranslation();
  const { connected, publicKey } = useWalletStore();
  const {
    showRiskDisclosure,
    acceptRiskDisclosure,
    cancelRiskDisclosure,
  } = useWalletConnect();
  const {
    data: positions = [],
    isError: positionsError,
    refetch: refetchPositions,
  } = usePositions(publicKey);

  // Route to the server's recommendation: the highest-APY vault Meridian can
  // actually deposit into (excludes display-only protocols and risky pools).
  const bestVault = vaults?.find((v) => v.id === data?.recommendedVaultId);
  // Deposits and withdrawals both target the recommended vault. A position
  // in some other vault must not be shown or withdrawn here.
  const position = bestVault
    ? positions.find((p) => p.vaultId === bestVault.id)
    : undefined;
  const hasPosition: boolean =
    !!position && Number.isFinite(position.deposited) && position.deposited > 0;

  return (
    <div className="rounded-2xl border border-gray-800 bg-deep overflow-hidden shadow-xl shadow-black/40 max-w-full">
      {/* Hero — identity + stats */}
      <div className="px-4 pt-5 pb-5 sm:px-7 sm:pt-7 sm:pb-6">
        {vaultsLoading ? (
          <div className="flex justify-between gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-10 bg-gray-800 rounded animate-pulse" />
                <div className="h-8 w-16 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : bestVault ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs text-gray-500 mb-1.5">
                {t("vaultPanel.apy")}
              </p>
              <div className="flex items-baseline gap-0.5">
                <span className="text-3xl sm:text-5xl font-black text-emerald-400 tabular-nums tracking-tight">
                  {bestVault.apy.toFixed(2)}
                </span>
                <span className="text-lg sm:text-xl font-bold text-emerald-600">%</span>
              </div>
            </div>
            <div className="pb-1 sm:text-center">
              <p className="text-xs text-gray-500 mb-1.5">
                {t("vaultPanel.tvl")}
              </p>
              <p className="text-base sm:text-lg font-bold text-paper">
                {formatTvl(bestVault.tvl)}
              </p>
            </div>
            <div className="pb-1 sm:text-right">
              <p className="text-xs text-gray-500 mb-1.5">
                {t("vaultPanel.route")}
              </p>
              <p className="text-base sm:text-lg font-bold text-paper break-words">
                {PROTOCOL_LABEL[bestVault.protocol] ?? bestVault.protocol}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            {t("vaultPanel.noLiveRateData")}
          </p>
        )}
      </div>

      {/* Position summary */}
      {connected && hasPosition && position && (
        <PositionSummary position={position} />
      )}

      {/* Yield history: position value over time, by protocol */}
      {connected && hasPosition && position && (
        <YieldHistoryChart publicKey={publicKey} />
      )}

      {/* Position load error — deposit/withdraw stay usable, only the
          position summary is affected. */}
      {connected && positionsError && (
        <div className="mx-4 sm:mx-7 my-5 rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-sm text-amber-400">
            {t("vaultPanel.positionsError")}
          </p>
          <button
            onClick={() => void refetchPositions()}
            className="shrink-0 min-h-[44px] min-w-[44px] rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Action area */}
      <div className="px-4 py-5 sm:px-7 sm:py-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        {!connected ? (
          <div className="space-y-4">
            {showRiskDisclosure && (
              <RiskDisclosureModal
                onAccept={acceptRiskDisclosure}
                onCancel={cancelRiskDisclosure}
              />
            )}
            <p className="text-sm text-gray-400 leading-relaxed">
              {t("vaultPanel.connectUSDC")}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
