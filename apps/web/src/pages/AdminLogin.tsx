import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertCircle, Lock, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { shortenAddress } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { AdminDashboard } from "./AdminDashboard";
import {
  clearAdminToken,
  getAdminToken,
  loginAsAdmin,
  onAdminSessionChange,
} from "../lib/adminSession";
import { getSelectedWalletId, getWalletAdapter } from "../lib/wallet";

type LoginState = "idle" | "signing" | "blocked" | "error" | "allowed";
type ApiError = Error & { status?: number };

export function AdminLogin() {
  const { t } = useTranslation();
  const { publicKey, connected, disconnect } = useWalletStore();
  const { handleConnect, status: connectStatus } = useWalletConnect({
    skipRiskDisclosure: true,
  });
  const sessionToken = useSyncExternalStore(
    onAdminSessionChange,
    getAdminToken,
    () => null
  );
  const [login, setLogin] = useState<{
    key: string | null;
    state: LoginState;
    error: string | null;
  }>({ key: null, state: "idle", error: null });
  const adapter = getWalletAdapter(getSelectedWalletId());

  useEffect(() => {
    clearAdminToken();
  }, [publicKey]);

  const state = login.key === publicKey ? login.state : "idle";
  const error = login.key === publicKey ? login.error : null;

  const signIn = async () => {
    if (!publicKey) return;
    setLogin({ key: publicKey, state: "signing", error: null });
    try {
      await loginAsAdmin(publicKey, adapter);
      setLogin({ key: publicKey, state: "allowed", error: null });
    } catch (cause) {
      const err = cause as ApiError;
      if (err.status === 401 || err.status === 403)
        setLogin({ key: publicKey, state: "blocked", error: null });
      else setLogin({ key: publicKey, state: "error", error: err.message });
    }
  };

  if (!connected || !publicKey)
    return (
      <Shell icon={<LockOpen />} title={t("admin.access")}>
        <p className="mt-2 text-sm text-gray-400">{t("admin.connectPrompt")}</p>
        <button
          onClick={() => void handleConnect()}
          disabled={connectStatus === "connecting"}
          className="mt-6 w-full rounded-lg bg-settled px-6 py-3 font-semibold text-white disabled:opacity-50"
        >
          {t("common.connectWallet")}
        </button>
      </Shell>
    );

  if (state === "allowed" && sessionToken)
    return (
      <div className="min-h-screen bg-night text-paper">
        <AdminDashboard />
      </div>
    );
  if (state === "blocked")
    return (
      <Shell icon={<Lock />} title={t("admin.notAuthorized")}>
        <Address address={publicKey} t={t} />
        <button
          onClick={disconnect}
          className="mt-3 w-full rounded-lg border border-gray-700 px-6 py-3 font-semibold text-gray-200"
        >
          {t("admin.switchWallet")}
        </button>
      </Shell>
    );

  return (
    <Shell icon={<AlertCircle />} title={t("admin.title")}>
      <Address address={publicKey} t={t} />
      {error && <p className="mt-4 text-sm text-amber-400">{error}</p>}
      {!adapter.signMessage && (
        <p className="mt-4 text-sm text-amber-400">
          {t("admin.walletCannotSign")}
        </p>
      )}
      <button
        onClick={() => void signIn()}
        disabled={state === "signing" || !adapter.signMessage}
        className="mt-6 w-full rounded-lg bg-settled px-6 py-3 font-semibold text-white disabled:opacity-50"
      >
        {state === "signing" ? t("admin.signing") : t("admin.signIn")}
      </button>
      <button
        onClick={disconnect}
        className="mt-3 w-full rounded-lg border border-gray-700 px-6 py-3 font-semibold text-gray-200"
      >
        {t("admin.switchWallet")}
      </button>
    </Shell>
  );
}

function Address({
  address,
  t,
}: {
  address: string;
  t: (key: string) => string;
}) {
  return (
    <div className="mt-6 flex items-center justify-between rounded-lg bg-night px-4 py-3 text-sm">
      <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
        {t("admin.connected")}
      </span>
      <span className="font-mono text-gray-300">{shortenAddress(address)}</span>
    </div>
  );
}

function Shell({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-night">
      <div className="w-full max-w-md rounded-xl border border-gray-800 bg-deep p-8 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-gray-800">
          {icon}
        </div>
        <h1 className="text-xl font-bold text-paper">{title}</h1>
        {children}
      </div>
    </div>
  );
}
