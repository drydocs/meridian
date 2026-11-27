import { useState } from "react";
import { useTranslation } from "react-i18next";
import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

export function NetworkMismatchBanner() {
  const { t } = useTranslation();
  const { connected, walletNetwork, refreshNetwork } = useWalletStore();
  const { push } = useToastStore();
  const [isRetrying, setIsRetrying] = useState(false);

  if (!connected || walletNetwork === APP_NETWORK.network) return null;

  async function handleRetry() {
    setIsRetrying(true);
    try {
      await refreshNetwork();
    } catch {
      push("error", t("walletConnect.networkCheckFailed"));
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div
      role={walletNetwork ? "alert" : "status"}
      data-testid="network-mismatch-banner"
      className="border-b border-amber-700/70 bg-amber-950/80 px-4 py-3 text-amber-100"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          {walletNetwork
            ? t("walletConnect.networkMismatch", {
                walletNetwork: t(`walletConnect.networks.${walletNetwork}`),
                appNetwork: t(`walletConnect.networks.${APP_NETWORK.network}`),
              })
            : t("walletConnect.networkUnknown", {
                appNetwork: t(`walletConnect.networks.${APP_NETWORK.network}`),
              })}
        </p>
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={isRetrying}
          className="shrink-0 rounded-lg border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-100 hover:border-amber-500 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:outline-none"
        >
          {isRetrying ? t("walletConnect.checkingNetwork") : t("common.retry")}
        </button>
      </div>
    </div>
  );
}
