import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { wallet } from "../lib/wallet";
import { api } from "../lib/api";
import {
  TransactionNotConfirmedError,
  WALLET_DISCONNECTED_ERROR,
} from "../lib/errorMapper";

export function useSignAndSubmit() {
  const { t } = useTranslation();
  const { revalidate } = useWalletStore();
  // The passphrase is a build-time invariant, not user state. Sourcing it from
  // APP_NETWORK avoids the stale-persisted-network bug (#851) where the store
  // could hold "testnet" on a mainnet build and cause xBull to sign against
  // the wrong network hash.
  const passphrase = APP_NETWORK.passphrase;
  // Tracks the current authorization+sign request so a visible cancel control
  // can abort it. Only the latest request may clear the ref, so a superseded
  // run can't cancel its replacement.
  const controllerRef = useRef<AbortController | null>(null);

  async function signAndSubmit(xdr: string): Promise<string> {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await revalidate(controller.signal);
      if (!useWalletStore.getState().connected) {
        // Throw a stable, locale-independent code instead of the translated
        // `walletConnect.walletDisconnected` string so mapError() can detect the
        // disconnect in every locale.
        throw new Error(WALLET_DISCONNECTED_ERROR);
      }
      if (typeof wallet.getNetwork === "function") {
        const currentNetwork = await wallet.getNetwork();
        if (currentNetwork && currentNetwork !== APP_NETWORK.network) {
          throw new Error(
            t("walletConnect.networkMismatch", {
              walletNetwork: currentNetwork,
              appNetwork: APP_NETWORK.network,
              defaultValue: `Wallet network mismatch: wallet is on ${currentNetwork}, but app requires ${APP_NETWORK.network}`,
            })
          );
        }
      }
      const signedXdr = await wallet.sign(xdr, passphrase, {
        signal: controller.signal,
      });
      const result = await api.submitTx({ xdr: signedXdr });
      if (result.status === "PENDING" || result.status === "OUTCOME_UNKNOWN") {
        throw new TransactionNotConfirmedError(result.status, result.hash);
      }
      return result.hash;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  // Aborts the authorization check or signature in flight. The wallet SDKs
  // may still resolve later, but that result is ignored and the caller's
  // pending state exits through the rejection.
  function cancelSign() {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }

  return { signAndSubmit, cancelSign, passphrase };
}
