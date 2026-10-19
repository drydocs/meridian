import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Lock, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";
import { APP_ADDRESSES, APP_NETWORK, shortenAddress } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { AdminDashboard } from "./AdminDashboard";

// Keyed by the public key it was resolved for, so a wallet switch is
// recognized as "not checked yet" (loading) during render rather than
// needing an effect to reset it back to loading first.
interface GateResult {
  publicKey: string;
  authorized?: boolean;
  error?: boolean;
}

export function AdminLogin() {
  const { t } = useTranslation();
  const { publicKey, connected, disconnect } = useWalletStore();
  const { handleConnect, status: connectStatus } = useWalletConnect({
    skipRiskDisclosure: true, // this isn't a deposit
  });
  const [result, setResult] = useState<GateResult | null>(null);

  const checkAdmin = useCallback((key: string) => {
    let cancelled = false;
    fetchVaultAdmin({ contractId: APP_ADDRESSES.vault, network: APP_NETWORK })
      .then((admin) => {
        if (!cancelled) {
          setResult({ publicKey: key, authorized: admin === key });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ publicKey: key, error: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!connected || !publicKey) return;
    return checkAdmin(publicKey);
  }, [connected, publicKey, checkAdmin]);

  const handleRetry = () => {
    if (!publicKey) return;
    setResult(null);
    checkAdmin(publicKey);
  };

  const status: "loading" | "blocked" | "allowed" | "error" =
    result?.publicKey !== publicKey
      ? "loading"
      : result.error
        ? "error"
        : result.authorized
          ? "allowed"
          : "blocked";

  if (!connected) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-night">
        <div className="w-full max-w-md rounded-xl border border-gray-800 bg-deep p-8 text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-gray-800">
            <LockOpen className="h-5 w-5 text-gray-400" />
          </div>
          <h1 className="text-xl font-bold text-paper">{t("admin.access")}</h1>
          <p className="mt-2 text-sm text-gray-400">
            {t("admin.connectPrompt")}
          </p>
          <button
            onClick={() => void handleConnect()}
            disabled={connectStatus === "connecting"}
            className="mt-6 w-full rounded-lg bg-settled px-6 py-3 font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {t("common.connectWallet")}
          </button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-night">
        <div className="w-full max-w-md rounded-xl border border-gray-800 bg-deep p-8 text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-amber-500/10">
            <AlertCircle className="h-5 w-5 text-amber-400" />
          </div>
          <h1 className="text-xl font-bold text-paper">{t("admin.title")}</h1>
          <p className="mt-2 text-sm text-amber-400">{t("admin.readError")}</p>
          <div className="mt-6 flex items-center justify-between rounded-lg bg-night px-4 py-3 text-sm">
            <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              {t("admin.connected")}
            </span>
            <span className="font-mono text-gray-300">
              {shortenAddress(publicKey ?? "")}
            </span>
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={handleRetry}
              className="w-full rounded-lg bg-settled px-6 py-3 font-semibold text-white hover:bg-emerald-600 transition-colors duration-150"
            >
              {t("common.retry")}
            </button>
            <button
              onClick={disconnect}
              className="w-full rounded-lg border border-gray-700 px-6 py-3 font-semibold text-gray-200 hover:border-gray-600 hover:text-paper transition-colors duration-150"
            >
              {t("admin.switchWallet")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-night">
        <div className="w-full max-w-md rounded-xl border border-gray-800 bg-deep p-8 text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-red-500/10">
            <Lock className="h-5 w-5 text-red-400" />
          </div>
          <h1 className="text-xl font-bold text-paper">
            {t("admin.notAuthorized")}
          </h1>
          <div className="mt-6 flex items-center justify-between rounded-lg bg-night px-4 py-3 text-sm">
            <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              {t("admin.connected")}
            </span>
            <span className="font-mono text-gray-300">
              {shortenAddress(publicKey ?? "")}
            </span>
          </div>
          <button
            onClick={disconnect}
            className="mt-3 w-full rounded-lg border border-gray-700 px-6 py-3 font-semibold text-gray-200 hover:border-gray-600 hover:text-paper transition-colors duration-150"
          >
            {t("admin.switchWallet")}
          </button>
        </div>
      </div>
    );
  }

  if (status === "allowed") {
    return (
      <div className="min-h-screen bg-night text-paper">
        <AdminDashboard />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-night text-gray-400">
      {t("admin.loading")}
    </div>
  );
}
