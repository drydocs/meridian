import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { WalletState } from "../types";
import { wallet } from "../lib/wallet";
import { APP_NETWORK } from "@meridian/shared";

interface WalletStore extends WalletState {
  connect: (publicKey: string) => void;
  disconnect: () => void;
  setNetwork: (network: WalletState["network"]) => void;
  revalidate: () => Promise<void>;
}

export const useWalletStore = create<WalletStore>()(
  persist(
    (set, get) => ({
      publicKey: null,
      // Default to the build's actual network, not a hardcoded literal.
      // Previously this was hardcoded to "testnet", which caused xBull to sign
      // mainnet transactions with the testnet passphrase on the mainnet build
      // (#851). The migration below clears any stale persisted value.
      network: APP_NETWORK.network,
      connected: false,

      connect: (publicKey) => set({ publicKey, connected: true }),
      disconnect: () => set({ publicKey: null, connected: false }),
      setNetwork: (network) => set({ network }),

      // Re-check the persisted key against Freighter. Clears stale state when
      // the extension is gone or the user revoked site access between sessions.
      revalidate: async () => {
        if (!get().publicKey) return;
        const authorized = await wallet.isAuthorized();
        if (!authorized) set({ publicKey: null, connected: false });
      },
    }),
    {
      name: "meridian-wallet",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // v0 → v1: the `network` field was hardcoded to "testnet" at init time
      // and persisted (#851). Override any persisted value with the build's
      // actual network so a returning mainnet user isn't stuck with a stale
      // "testnet" entry in localStorage.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<WalletState>;
        if (version < 1) {
          state.network = APP_NETWORK.network;
        }
        return state;
      },
      partialize: (s) => ({ publicKey: s.publicKey, network: s.network }),
      // `connected` is never persisted — re-derive it from the restored key.
      onRehydrateStorage: () => (state) => {
        if (state) state.connected = state.publicKey != null;
      },
    }
  )
);
