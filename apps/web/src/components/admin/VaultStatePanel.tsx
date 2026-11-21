import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useVaultState } from "../../hooks/useVaultState";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import { useWallet } from "../../hooks/useWallet";
import { PROTOCOL_LABEL } from "../../lib/protocolLabels";
import { APP_NETWORK } from "@meridian/shared";

function formatAmount(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function VaultStatePanel() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useVaultState();
  const { isAdmin, isLoading: isAdminLoading } = useAdminAuth();
  const { address, signAndSubmit } = useWallet();

  const [targetPausedState, setTargetPausedState] = useState<boolean | null>(null);
  const [confirmationInput, setConfirmationInput] = useState("");
  const [txStatus, setTxStatus] = useState<"idle" | "building" | "signing" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const expectedConfirmText = targetPausedState ? "PAUSE" : "UNPAUSE";
  const isConfirmed = confirmationInput.trim().toUpperCase() === expectedConfirmText;

  const handleOpenConfirm = (pause: boolean) => {
    setTargetPausedState(pause);
    setConfirmationInput("");
    setTxStatus("idle");
    setTxHash(null);
    setErrorMessage(null);
  };

  const handleCancel = () => {
    setTargetPausedState(null);
    setConfirmationInput("");
    setTxStatus("idle");
  };

  const handleExecute = async () => {
    if (targetPausedState === null || !isConfirmed || !address) return;

    try {
      setTxStatus("building");
      setErrorMessage(null);

      const res = await fetch("/api/v1/tx/set_paused", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultId: "meridian-usdc",
          paused: targetPausedState,
          signer: address,
          network: APP_NETWORK.network,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || "Failed to build transaction");
      }

      const { xdr } = await res.json();

      setTxStatus("signing");
      const hash = await signAndSubmit(xdr);

      setTxHash(hash);
      setTxStatus("success");
      void refetch();
    } catch (err: any) {
      setTxStatus("error");
      setErrorMessage(err?.message || "Transaction failed");
    }
  };

  const explorerUrl = txHash
    ? `https://stellar.expert/explorer/${APP_NETWORK.network}/tx/${txHash}`
    : null;

  return (
    <div className="rounded-2xl border border-gray-800 bg-deep overflow-hidden shadow-xl shadow-black/40">
      <div className="px-6 pt-5 pb-4 border-b border-gray-800 flex items-center justify-between">
        <p className="text-sm font-semibold text-paper">
          {t("admin.vaultState.title")}
        </p>
        {isAdmin && data && targetPausedState === null && txStatus !== "success" && (
          <button
            onClick={() => handleOpenConfirm(!data.paused)}
            className={`px-3 py-1 text-xs font-semibold rounded-lg border transition-colors ${
              data.paused
                ? "border-emerald-800/70 bg-emerald-950/30 text-emerald-400 hover:bg-emerald-900/40"
                : "border-amber-800/70 bg-amber-950/30 text-amber-400 hover:bg-amber-900/40"
            }`}
          >
            {data.paused ? t("admin.vaultState.unpause") : t("admin.vaultState.pause")}
          </button>
        )}
      </div>

      <div className="px-6 py-5">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 bg-gray-800 rounded animate-pulse" />
                <div className="h-5 w-20 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : isError || !data ? (
          <div className="rounded-xl border border-amber-800/70 bg-amber-950/20 px-4 py-3.5 flex items-center justify-between gap-3">
            <p className="text-sm text-amber-400">
              {t("admin.vaultState.loadError")}
            </p>
            <button
              onClick={() => void refetch()}
              className="shrink-0 rounded-lg border border-amber-800/70 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-700 hover:text-amber-200 transition-colors duration-150"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : targetPausedState !== null ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
              <p className="text-xs font-medium text-gray-300">
                {targetPausedState
                  ? t("admin.vaultState.confirmPausePrompt")
                  : t("admin.vaultState.confirmUnpausePrompt")}
              </p>
              <p className="text-xs text-gray-500">
                {t("admin.vaultState.typeToConfirm", { text: expectedConfirmText })}
              </p>
              <input
                type="text"
                value={confirmationInput}
                onChange={(e) => setConfirmationInput(e.target.value)}
                placeholder={expectedConfirmText}
                disabled={txStatus === "building" || txStatus === "signing"}
                data-testid="vault-confirm-input"
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-paper focus:outline-none focus:border-gray-500"
              />
            </div>

            {txStatus === "building" && (
              <p className="text-xs text-amber-400 animate-pulse" data-testid="vault-tx-status">
                {t("admin.vaultState.buildingTx")}
              </p>
            )}
            {txStatus === "signing" && (
              <p className="text-xs text-amber-400 animate-pulse" data-testid="vault-tx-status">
                {t("admin.vaultState.signingTx")}
              </p>
            )}
            {txStatus === "error" && errorMessage && (
              <p className="text-xs text-red-400" data-testid="vault-tx-error">
                {errorMessage}
              </p>
            )}
            {txStatus === "success" && txHash && (
              <div className="space-y-2" data-testid="vault-tx-success">
                <p className="text-xs text-emerald-400">
                  {t("admin.vaultState.success")}
                </p>
                {explorerUrl && (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-sky-400 hover:underline block"
                    data-testid="vault-explorer-link"
                  >
                    {t("admin.vaultState.viewExplorer")} &rarr;
                  </a>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              {txStatus !== "success" && (
                <button
                  onClick={handleCancel}
                  disabled={txStatus === "building" || txStatus === "signing"}
                  className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  {t("common.cancel")}
                </button>
              )}
              {txStatus === "success" ? (
                <button
                  onClick={() => {
                    setTargetPausedState(null);
                    setTxStatus("idle");
                  }}
                  className="rounded-lg bg-paper px-3 py-1.5 text-xs font-semibold text-deep hover:bg-gray-200 transition-colors"
                >
                  {t("common.done")}
                </button>
              ) : (
                <button
                  onClick={() => void handleExecute()}
                  disabled={!isConfirmed || txStatus === "building" || txStatus === "signing"}
                  data-testid="vault-confirm-execute-btn"
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    !isConfirmed || txStatus === "building" || txStatus === "signing"
                      ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                      : "bg-paper text-deep hover:bg-gray-200"
                  }`}
                >
                  {targetPausedState ? t("admin.vaultState.pause") : t("admin.vaultState.unpause")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-y-5 gap-x-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.adapter")}
              </p>
              <p className="text-sm font-semibold text-paper">
                {PROTOCOL_LABEL[data.protocol] ?? data.protocol}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.status")}
              </p>
              <span
                data-testid="vault-state-badge"
                className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  data.paused
                    ? "bg-amber-950/40 text-amber-400 border border-amber-800/70"
                    : "bg-emerald-950/40 text-emerald-400 border border-emerald-800/70"
                }`}
              >
                {t(
                  data.paused
                    ? "admin.vaultState.paused"
                    : "admin.vaultState.active"
                )}
              </span>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.totalShares")}
              </p>
              <p className="text-sm font-semibold text-paper tabular-nums">
                {formatAmount(data.totalShares)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">
                {t("admin.vaultState.totalAssets")}
              </p>
              <p className="text-sm font-semibold text-paper tabular-nums">
                {formatAmount(data.totalAssets)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
