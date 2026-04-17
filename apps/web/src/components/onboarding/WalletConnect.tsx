"use client";
import { useWalletStore } from "../../store/wallet";
import { shortenAddress } from "@meridian/shared";

// TODO(#issue-2): wire up Freighter / Albedo wallet adapter
export function WalletConnect() {
  const { connected, publicKey, connect, disconnect } = useWalletStore();

  if (connected && publicKey) {
    return (
      <button
        onClick={disconnect}
        className="text-sm border border-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-800 transition"
      >
        {shortenAddress(publicKey)} · Disconnect
      </button>
    );
  }

  return (
    <button
      onClick={() => connect("PLACEHOLDER_PUBLIC_KEY")}
      className="text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg px-4 py-1.5 font-medium transition"
    >
      Connect Wallet
    </button>
  );
}
