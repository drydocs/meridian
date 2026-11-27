import { Suspense, lazy, useState } from "react";
import { useVaults } from "../../hooks/useVaults";
import { usePositions } from "../../hooks/usePositions";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { useRiskDisclosure } from "../../hooks/useRiskDisclosure";
import { useUsdcBalance } from "../../hooks/useUsdcBalance";
import { getWalletMeta, hasAcceptedRiskDisclosure } from "../../lib/wallet";
import { PositionSummary } from "./PositionSummary";
import { PositionPnlCard } from "./PositionPnlCard";
import { DepositTab } from "./DepositTab";
import { WithdrawTab } from "./WithdrawTab";
import { RiskDisclosureModal } from "../onboarding/RiskDisclosureModal";
import { useTranslation } from "react-i18next";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";
import { formatApy, formatCompactUsd, parseMoneyInput } from "../../lib/format";
import { ActivityHistory } from "./ActivityHistory";
import type { LocalActivity } from "../../store/activity";

const VaultListEmptyState = lazy(() =>
  import("./VaultListEmptyState").then((m) => ({
    default: m.VaultListEmptyState,
  }))
);

const YieldHistoryChart = lazy(() =>
  import("./YieldHistoryChart").then((m) => ({
    default: m.YieldHistoryChart,
  }))
);

type Tab = "deposit" | "withdraw";

export function VaultPanel() {
  const {
    data,
    isLoading: vaultsLoading,
    dataUpdatedAt: vaultsUpdatedAt,
    isStale: vaultsStale,
    isError: vaultsError,
    refetch: refetchVaults,
  } = useVaults();
  const vaults = data?.vaults;
  const { t, i18n } = useTranslation();
  const { connected, publicKey } = useWalletStore();
  const {
    balance: availableBalance,
    isError: balanceError,
    refetch: refetchBalance,
  } = useUsdcBalance();
  const {
    handleConnect,
    cancelConnect,
    retryConnect,
    status: connectStatus,
    attemptedWalletId,
    showRiskDisclosure,
    acceptRiskDisclosure,
    cancelRiskDisclosure,
  } = useWalletConnect();
  const {
    data: positions = [],
    isError: positionsError,
    refetch: refetchPositions,
  } = usePositions(publicKey);
  const {
    deposit,
    withdraw,
    isDepositing,
    isWithdrawing,
    isSigning,
    cancelPending,
  } = useVaultActions();

  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");
  // Deposit-time gate. useWalletConnect's gate only fires from the connect
  // button, so a wallet already connected elsewhere (e.g. via AdminLogin,
  // which skips the disclosure) would otherwise reach this deposit button
  // with no way to ever see or accept it. Both gates now share the same
  // useRiskDisclosure hook (#814) rather than duplicating its state/logic.
  const depositRiskDisclosure = useRiskDisclosure();

  function onAmountKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const allowed = [
      "Backspace",
      "Delete",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      ".",
      ",",
      " ",
    ];
    if (allowed.includes(e.key) || (e.key >= "0" && e.key <= "9")) return;
    e.preventDefault();
  }

  // Route to the server's recommendation: the highest-APY vault Meridian can
  // actually deposit into (excludes display-only protocols and risky pools).
  const bestVault = vaults?.find((v) => v.id === data?.recommendedVaultId);
  // Deposits and withdrawals both target the recommended vault. A position
  // in some other vault must not be shown or withdrawn here: its share price
  // does not match bestVault, so the withdraw tab would display the wrong
  // balance and the contract would revert.
  const position = bestVault
    ? positions.find((p) => p.vaultId === bestVault.id)
    : undefined;
  const hasPosition =
    position && Number.isFinite(position.deposited) && position.deposited > 0;

  async function handleDeposit() {
    if (!amount || !bestVault) return;
    // Runs the deposit now if already accepted, otherwise once the user
    // accepts the disclosure modal below (#814).
    await depositRiskDisclosure.requireAcceptance(() =>
      executeDeposit(bestVault)
    );
  }

  async function executeDeposit(vault: NonNullable<typeof bestVault>) {
    // Slippage floors are computed in useVaultActions from a fresh on-chain
    // vault state read at tx-build time. Do not derive them from cached
    // position.deposited / position.shares — that share price can lag yield
    // accrual and cause unnecessary SlippageExceeded reverts.
    const ok = await deposit(
      amount,
      vault.id,
      vault.asset,
      undefined,
      hasAcceptedRiskDisclosure()
    );
    if (ok) {
      setAmount("");
      // A successful deposit changes the wallet's USDC balance; refresh
      // so the over-balance guard stops comparing against stale data.
      refetchBalance();
    }
  }

  async function handleWithdraw() {
    if (!amount || !bestVault || !position) return;
    if (position.vaultId !== bestVault.id) return;
    const canonicalAmount = parseMoneyInput(amount, i18n.language);
    if (
      canonicalAmount === null ||
      canonicalAmount === "" ||
      Number(canonicalAmount) > position.shares
    ) {
      return;
    }
    const ok = await withdraw(
      canonicalAmount,
      bestVault.id,
      bestVault.asset,
      undefined
    );
    if (ok) {
      setAmount("");
      refetchBalance();
    }
  }

  function handleTabChange(next: Tab) {
    setTab(next);
    setAmount("");
  }

  async function retryActivity(activity: LocalActivity) {
    if (activity.action === "deposit") {
      await deposit(
        activity.amount,
        activity.vaultId,
        activity.asset,
        undefined,
        hasAcceptedRiskDisclosure()
      );
    } else if (position && activity.vaultId === bestVault?.id) {
      await withdraw(activity.amount, activity.vaultId, activity.asset);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-800 bg-deep overflow-hidden shadow-xl shadow-black/40">
      {/* Hero — identity + stats */}
      <div className="px-7 pt-7 pb-6">
        {/* Identity row */}
        <div className="flex items-center justify-between mb-8">
          <div className="text-right">
            <p className="text-xs text-gray-400 mb-0.5">
              {t("vaultPanel.network")}
            </p>
            <p className="text-xs font-semibold text-gray-300">Stellar</p>
          </div>
        </div>

        {/* Stats row or empty state */}
        {vaultsLoading ? (
          <div
            className="flex justify-between"
            data-testid="vault-loading-skeleton"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-10 bg-gray-800 rounded animate-pulse" />
                <div className="h-8 w-16 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : vaultsError ? (
          <VaultListEmptyState
            kind="failure"
            onRetry={() => void refetchVaults()}
          />
        ) : !vaults || vaults.length === 0 ? (
          <VaultListEmptyState kind="no-vaults" />
        ) : bestVault ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs text-gray-400 mb-1.5">
                {t("vaultPanel.apy")}
              </p>
              <div className="flex items-baseline gap-0.5">
                <span className="text-5xl font-black text-emerald-400 tabular-nums tracking-tight">
                  {formatApy(bestVault.apy, i18n.language)}
                </span>
                <span className="text-xl font-bold text-emerald-600">%</span>
              </div>
            </div>
            <div className="pb-1 sm:text-center">
              <p className="text-xs text-gray-400 mb-1.5">
                {t("vaultPanel.tvl")}
              </p>
              <p className="text-lg font-bold text-paper">
                {formatCompactUsd(bestVault.tvl, i18n.language)}
              </p>
              {vaultsStale && (
                <span className="inline-block mt-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 bg-amber-950/40 border border-amber-800/70">
                  {t("status.stale")}
                </span>
              )}
              {vaultsUpdatedAt > 0 && (
                <p className="text-[10px] text-gray-600 mt-0.5">
                  {t("status.lastUpdated")}{" "}
                  {new Intl.DateTimeFormat(i18n.language, {
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(vaultsUpdatedAt))}
                </p>
              )}
            </div>
            <div className="pb-1 sm:text-right">
              <p className="text-xs text-gray-400 mb-1.5">
                {t("vaultPanel.route")}
              </p>
              <p className="text-lg font-bold text-paper">
                {PROTOCOL_LABEL[bestVault.protocol] ?? bestVault.protocol}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400">
            {t("vaultPanel.noLiveRateData")}
          </p>
        )}
      </div>

      {/* Position summary */}
      {connected && hasPosition && position && (
        <PositionSummary position={position} />
      )}

      {/* Position PnL & yield breakdown */}
      {connected && hasPosition && position && (
        <PositionPnlCard position={position} />
      )}

      {/* Yield history: position value over time, by protocol */}
      {connected && hasPosition && position && (
        <Suspense
          fallback={
            <div className="mx-7 my-5 h-48 rounded-xl border border-gray-800 bg-gray-900/50 animate-pulse" />
          }
        >
          <YieldHistoryChart publicKey={publicKey} />
        </Suspense>
      )}

      {/* Position load error — deposit/withdraw stay usable, only the
          position summary is affected. */}
      {connected && positionsError && (
        <div className="mx-7 my-5 rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3">
          <p className="text-sm text-amber-400">
            {t("vaultPanel.positionsError")}
          </p>
          <button
            onClick={() => void refetchPositions()}
            className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Tab switcher */}
      {connected && (
        <div
          role="tablist"
          aria-label={t("vaultPanel.tabs.actions", "Vault actions")}
          className="flex border-b border-gray-800"
        >
          {(["deposit", "withdraw"] as Tab[]).map((tabId) => (
            <button
              key={tabId}
              role="tab"
              id={`vault-tab-${tabId}`}
              aria-selected={tab === tabId}
              aria-controls={`vault-tabpanel-${tabId}`}
              tabIndex={tab === tabId ? 0 : -1}
              data-testid={`vault-tab-${tabId}`}
              onClick={() => handleTabChange(tabId)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const nextTab: Tab =
                    tabId === "deposit" ? "withdraw" : "deposit";
                  handleTabChange(nextTab);
                  document.getElementById(`vault-tab-${nextTab}`)?.focus();
                }
              }}
              className={`flex-1 py-3 text-sm font-semibold transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-settled focus-visible:outline-none ${
                tab === tabId
                  ? "text-paper border-b-2 border-settled"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {t(`vaultPanel.${tabId}`)}
            </button>
          ))}
        </div>
      )}

      {/* Action area */}
      <div className="px-7 py-6">
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
            {connectStatus === "no-extension" ? (
              <a
                href={getWalletMeta(attemptedWalletId).installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center w-full rounded-xl border border-amber-800/70 bg-amber-950/20 hover:border-amber-700 text-amber-400 hover:text-amber-300 text-sm font-medium py-3 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
              >
                {t("common.installWallet", {
                  name: getWalletMeta(attemptedWalletId).name,
                })}
              </a>
            ) : (
              <>
                <button
                  onClick={() => void handleConnect()}
                  disabled={connectStatus === "connecting"}
                  className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-500 text-white text-sm font-semibold py-3 transition-all duration-150 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
                >
                  {connectStatus === "connecting"
                    ? t("common.connecting")
                    : t("common.connectWallet")}
                </button>
                {connectStatus === "connecting" && (
                  <button
                    type="button"
                    data-testid="vault-connect-cancel"
                    onClick={cancelConnect}
                    className="w-full rounded-xl border border-gray-700 text-gray-400 hover:border-gray-600 hover:text-paper text-sm font-medium py-2.5 transition-colors duration-150"
                  >
                    {t("common.cancel")}
                  </button>
                )}
                {connectStatus === "timed-out" && (
                  <div
                    data-testid="vault-connect-timeout"
                    role="status"
                    className="rounded-xl border border-amber-800/70 bg-amber-950/20 p-3 text-xs text-amber-200"
                  >
                    <p className="font-semibold mb-1">
                      {t("walletConnect.timedOut")}
                    </p>
                    <p className="mb-2 leading-snug">
                      {t("walletConnect.timedOutHint")}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid="vault-connect-retry"
                        onClick={retryConnect}
                        className="rounded-lg bg-amber-700/60 px-3 py-1.5 font-medium text-amber-100 hover:bg-amber-700 transition-colors duration-150"
                      >
                        {t("common.retry")}
                      </button>
                      <button
                        type="button"
                        data-testid="vault-connect-dismiss"
                        onClick={cancelConnect}
                        className="rounded-lg border border-amber-800/70 px-3 py-1.5 text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div
            role="tabpanel"
            id={`vault-tabpanel-${tab}`}
            aria-labelledby={`vault-tab-${tab}`}
            tabIndex={0}
            className="outline-none"
          >
            {tab === "deposit" ? (
              <DepositTab
                amount={amount}
                onAmountChange={setAmount}
                onAmountKeyDown={onAmountKeyDown}
                bestVault={bestVault}
                position={position}
                hasPosition={!!hasPosition}
                isDepositing={isDepositing}
                isSigning={isSigning}
                onCancel={cancelPending}
                onSubmit={handleDeposit}
                availableBalance={availableBalance}
                isBalanceError={balanceError}
                onRetryBalance={refetchBalance}
              />
            ) : (
              <WithdrawTab
                amount={amount}
                onAmountChange={setAmount}
                onAmountKeyDown={onAmountKeyDown}
                bestVault={bestVault}
                position={position}
                hasPosition={!!hasPosition}
                isWithdrawing={isWithdrawing}
                isSigning={isSigning}
                onCancel={cancelPending}
                onSubmit={handleWithdraw}
              />
            )}
          </div>
        )}
        {depositRiskDisclosure.show && (
          <RiskDisclosureModal
            onAccept={() => void depositRiskDisclosure.accept()}
            onCancel={depositRiskDisclosure.cancel}
          />
        )}
      </div>

      {/* Local activity history */}
      {connected && (
        <div className="border-t border-gray-800/50">
          <ActivityHistory onRetry={retryActivity} />
        </div>
      )}
    </div>
  );
}