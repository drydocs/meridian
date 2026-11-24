import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { WalletState } from "../types";
import {
  wallet,
  WalletTimeoutError,
  WalletCancelledError,
} from "../lib/wallet";
import { APP_NETWORK } from "@meridian/shared";

interface WalletStore extends WalletState {
  connect: (publicKey: string) => void;
  disconnect: () => void;
  revalidate: (signal?: AbortSignal) => Promise<void>;
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

      // Re-check the persisted key against Freighter. Clears stale state when
      // the extension is gone or the user revoked site access between sessions.
      // Passing a signal marks the caller as the owner of failures, so a
      // timeout or cancellation is rethrown for it to surface.
      revalidate: async (signal?: AbortSignal) => {
        const key = get().publicKey;
        if (!key) return;
        let authorized: boolean;
        try {
          authorized = await wallet.isAuthorized({ signal });
        } catch (err) {
          // Background checks are fired with `void` from App.tsx and have no
          // caller to catch, so a hung or aborted extension must not become an
          // unhandled rejection. A slow or cancelled check says nothing about
          // site access, so keep the session as it is.
          const isDeadlineError =
            err instanceof WalletTimeoutError ||
            err instanceof WalletCancelledError;
          if (isDeadlineError && !signal) return;
          throw err;
        }
        // The user may have connected a different wallet while the check was
        // in flight; a stale result must not clear the newer session.
        if (!authorized && get().publicKey === key) {
          set({ publicKey: null, connected: false });
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
        if (state) state.connected = state.publicKey != null;
      },
    }
  )
);
