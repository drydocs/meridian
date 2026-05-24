import { useWalletStore } from "../../store/wallet";
import { shortenAddress } from "@meridian/shared";
import { useWalletConnect } from "../../hooks/useWalletConnect";

export function WalletConnect() {
  const { connected, publicKey, disconnect } = useWalletStore();
  const { handleConnect, status, error } = useWalletConnect();

  if (connected && publicKey) {
    return (
      <button
        onClick={disconnect}
        className="flex items-center gap-2 text-sm border border-gray-700 rounded-lg px-3 py-1.5 text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
        {shortenAddress(publicKey)}
        <span className="text-gray-600">·</span>
        <span className="text-gray-500">Disconnect</span>
      </button>
    );
  }

  if (status === "no-extension") {
    return (
      <a
        href="https://freighter.app"
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm border border-amber-800 rounded-lg px-4 py-1.5 font-medium text-amber-400 hover:border-amber-600 hover:text-amber-300 transition-colors duration-150"
      >
        Install Freighter
      </a>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleConnect}
        disabled={status === "connecting"}
        className="text-sm border border-gray-700 rounded-lg px-4 py-1.5 font-medium text-gray-300 hover:border-gray-600 hover:text-white transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {status === "connecting" ? "Connecting..." : "Connect Wallet"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
