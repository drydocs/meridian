import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { WalletState } from "../types";
import { wallet } from "../lib/wallet";
import { APP_NETWORK } from "@meridian/shared";

interface WalletStore extends WalletState {
  walletNetworkName: string | null;
  walletNetworkPassphrase: string | null;
  walletNetworkError: string | null;
  walletNetworkLoading: boolean;
  connect: (publicKey: string) => void;
  disconnect: () => void;
  revalidate: () => Promise<void>;
  refreshNetwork: () => Promise<void>;
}

let networkRequestId = 0;

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
      walletNetworkName: null,
      walletNetworkPassphrase: null,
      walletNetworkError: null,
      walletNetworkLoading: false,

      connect: (publicKey) => {
        networkRequestId++;
        set({
          publicKey,
          connected: true,
          walletNetworkName: null,
          walletNetworkPassphrase: null,
          walletNetworkError: null,
          walletNetworkLoading: false,
        });
      },
      disconnect: () => {
        networkRequestId++;
        set({
          publicKey: null,
          connected: false,
          walletNetworkName: null,
          walletNetworkPassphrase: null,
          walletNetworkError: null,
          walletNetworkLoading: false,
        });
      },

      refreshNetwork: async () => {
        const requestId = ++networkRequestId;
        const publicKey = get().publicKey;
        if (!publicKey) {
          set({
            walletNetworkName: null,
            walletNetworkPassphrase: null,
            walletNetworkError: null,
            walletNetworkLoading: false,
          });
          return;
        }

        set({ walletNetworkLoading: true, walletNetworkError: null });
        try {
          const network = await wallet.getNetwork();
          if (requestId !== networkRequestId || get().publicKey !== publicKey)
            return;
          set({
            walletNetworkName: network?.name ?? null,
            walletNetworkPassphrase: network?.passphrase ?? null,
            walletNetworkError: null,
          });
        } catch (error) {
          if (requestId !== networkRequestId || get().publicKey !== publicKey)
            return;
          set({
            walletNetworkName: null,
            walletNetworkPassphrase: null,
            walletNetworkError:
              error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (requestId === networkRequestId) {
            set({ walletNetworkLoading: false });
          }
        }
      },

      // Re-check the persisted key against Freighter. Clears stale state when
      // the extension is gone or the user revoked site access between sessions.
      revalidate: async () => {
        const key = get().publicKey;
        if (!key) return;
        const authorized = await wallet.isAuthorized();
        // The user may have connected a different wallet while the check was
        // in flight; a stale result must not clear the newer session.
        if (!authorized && get().publicKey === key) {
          get().disconnect();
        }
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
        if (state) {
          state.connected = state.publicKey != null;
          state.walletNetworkName = null;
          state.walletNetworkPassphrase = null;
          state.walletNetworkError = null;
          state.walletNetworkLoading = false;
        }
      },
    }
  )
);
