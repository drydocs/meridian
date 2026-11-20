import { useTranslation } from "react-i18next";
import { APP_NETWORK, STELLAR_NETWORKS } from "@meridian/shared";
import { useWalletStore } from "../../store/wallet";

export function NetworkMismatchBanner() {
  const { t } = useTranslation();
  const {
    connected,
    walletNetworkName,
    walletNetworkPassphrase,
    walletNetworkError,
    walletNetworkLoading,
    refreshNetwork,
  } = useWalletStore();

  if (!connected || walletNetworkPassphrase === APP_NETWORK.passphrase) {
    return null;
  }

  const expected = t(`networkMismatch.${APP_NETWORK.network}`);
  let detected: string;
  if (walletNetworkPassphrase === STELLAR_NETWORKS.testnet.passphrase) {
    detected = t("networkMismatch.testnet");
  } else if (walletNetworkPassphrase === STELLAR_NETWORKS.mainnet.passphrase) {
    detected = t("networkMismatch.mainnet");
  } else {
    detected = walletNetworkName ?? t("networkMismatch.unknownNetwork");
  }
  const isUnknown = walletNetworkPassphrase === null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="network-mismatch-banner"
      className="mb-6 rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3.5 text-amber-200"
    >
      <p className="text-sm font-semibold">
        {isUnknown
          ? t("networkMismatch.unknown")
          : t("networkMismatch.message")}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-300">
        <span>{t("networkMismatch.expected", { network: expected })}</span>
        <span>{t("networkMismatch.detected", { network: detected })}</span>
      </div>
      {walletNetworkError && (
        <p className="mt-2 text-xs text-amber-300">
          {t("networkMismatch.readError", { error: walletNetworkError })}
        </p>
      )}
      <button
        type="button"
        onClick={() => void refreshNetwork()}
        disabled={walletNetworkLoading}
        className="mt-3 rounded-lg border border-amber-700/70 px-3 py-1.5 text-xs font-medium text-amber-200 hover:border-amber-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {walletNetworkLoading
          ? t("networkMismatch.checking")
          : t("common.retry")}
      </button>
    </div>
  );
}
