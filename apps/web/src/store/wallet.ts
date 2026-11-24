import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { WalletState } from "../types";
import {
  wallet,
  WalletTimeoutError,
  WalletCancelledError,
} from "../lib/wallet";
import { APP_NETWORK, shortenAddress } from "@meridian/shared";
import { useToastStore } from "./toast";
import { queryClient } from "../lib/queryClient";
import i18n from "../i18n";

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

      // Re-check the persisted key against the wallet. Clears stale state when
      // the extension is gone or the user revoked site access between sessions,
      // and reconciles account/network switches. Passing a signal marks the
      // caller as the owner of failures, so a timeout or cancellation is
      // rethrown for it to surface.
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
        if (!authorized) {
          if (get().publicKey === key) {
            set({ publicKey: null, connected: false });
          }
          return;
        }

        if (get().publicKey !== key) {
          return;
        }

        let activeKey = key;

        // Reconcile passive address if supported
        if (typeof wallet.getAddress === "function") {
          try {
            const reportedAddress = await wallet.getAddress();
            if (
              get().publicKey === activeKey &&
              reportedAddress &&
              reportedAddress !== get().publicKey
            ) {
              activeKey = reportedAddress;
              set({ publicKey: reportedAddress, connected: true });
              const fallback = `Wallet account switched to ${shortenAddress(reportedAddress)}`;
              const message =
                (i18n.isInitialized
                  ? i18n.t("walletConnect.accountChanged", {
                      address: shortenAddress(reportedAddress),
                      defaultValue: fallback,
                    })
                  : null) || fallback;
              useToastStore.getState().push("info", message);
              queryClient.invalidateQueries({ queryKey: ["positions"] });
              queryClient.invalidateQueries({ queryKey: ["vaults"] });
              queryClient.invalidateQueries({ queryKey: ["vault-state"] });
            }
          } catch {
            // Passive queries must not break revalidation
          }
        }

        // Reconcile passive network if supported
        if (typeof wallet.getNetwork === "function") {
          try {
            const reportedNetwork = await wallet.getNetwork();
            if (
              get().publicKey === activeKey &&
              (reportedNetwork === "mainnet" ||
                reportedNetwork === "testnet") &&
              reportedNetwork !== get().network
            ) {
              set({ network: reportedNetwork });
              const fallback = `Wallet network switched to ${reportedNetwork}`;
              const message =
                (i18n.isInitialized
                  ? i18n.t("walletConnect.networkChanged", {
                      network: reportedNetwork,
                      defaultValue: fallback,
                    })
                  : null) || fallback;
              useToastStore.getState().push("info", message);
              queryClient.invalidateQueries({ queryKey: ["positions"] });
              queryClient.invalidateQueries({ queryKey: ["vaults"] });
              queryClient.invalidateQueries({ queryKey: ["vault-state"] });
            }
          } catch {
            // Passive queries must not break revalidation
          }
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
