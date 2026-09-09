import { useEffect, useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";
import { APP_ADDRESSES, APP_NETWORK, shortenAddress } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { RiskDisclosureModal } from "../components/onboarding/RiskDisclosureModal";
import { AdminDashboard } from "./AdminDashboard";

// Keyed by the public key it was resolved for, so a wallet switch is
// recognized as "not checked yet" (loading) during render rather than
// needing an effect to reset it back to loading first.
interface GateResult {
  publicKey: string;
  authorized: boolean;
}

export function AdminLogin() {
  const { publicKey, connected, disconnect } = useWalletStore();
  const {
    handleConnect,
    status: connectStatus,
    showRiskDisclosure,
    acceptRiskDisclosure,
    cancelRiskDisclosure,
  } = useWalletConnect();
  const [result, setResult] = useState<GateResult | null>(null);

  useEffect(() => {
    if (!connected || !publicKey) return;
    let cancelled = false;
    fetchVaultAdmin({ contractId: APP_ADDRESSES.vault, network: APP_NETWORK })
      .then((admin) => {
        if (!cancelled) {
          setResult({ publicKey, authorized: admin === publicKey });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ publicKey, authorized: false });
      });
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey]);

  const status: "loading" | "blocked" | "allowed" =
    result?.publicKey !== publicKey
      ? "loading"
      : result.authorized
        ? "allowed"
        : "blocked";

  if (!connected) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
        {showRiskDisclosure && (
          <RiskDisclosureModal
            onAccept={acceptRiskDisclosure}
            onCancel={cancelRiskDisclosure}
          />
        )}
        <div className="w-full max-w-md rounded-xl border border-gray-800 bg-[#161b22] p-8 text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-gray-800">
            <LockOpen className="h-5 w-5 text-gray-400" />
          </div>
          <h1 className="text-xl font-bold text-white">Admin access</h1>
          <p className="mt-2 text-sm text-gray-400">
            Connect the vault's admin wallet to view keeper health, vault state,
            and recent admin actions.
          </p>
          <button
            onClick={() => void handleConnect()}
            disabled={connectStatus === "connecting"}
            className="mt-6 w-full rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors duration-150"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
        <div className="w-full max-w-md rounded-xl border border-red-900/50 bg-[#161b22] p-8 text-center">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-red-500/10">
            <Lock className="h-5 w-5 text-red-400" />
          </div>
          <h1 className="text-xl font-bold text-white">Not authorized</h1>
          <p className="mt-2 text-sm text-gray-400">
            The connected wallet doesn't match the vault's admin address. This
            page is only accessible to the vault admin.
          </p>
          <div className="mt-6 flex items-center justify-between rounded-lg bg-[#0d1117] px-4 py-3 text-sm">
            <span className="text-xs font-medium tracking-wide text-gray-500 uppercase">
              Connected
            </span>
            <span className="font-mono text-gray-300">
              {shortenAddress(publicKey ?? "")}
            </span>
          </div>
          <button
            onClick={disconnect}
            className="mt-3 w-full rounded-lg border border-gray-700 px-6 py-3 font-semibold text-gray-200 hover:border-gray-600 hover:text-white transition-colors duration-150"
          >
            Switch Wallet
          </button>
        </div>
      </div>
    );
  }

  if (status === "allowed") {
    return (
      <div className="min-h-screen bg-[#0d1117] text-white">
        <AdminDashboard />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0d1117] text-gray-400">
      Loading...
    </div>
  );
}
