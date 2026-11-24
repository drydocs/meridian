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

  async function signAndSubmit(xdr: string) {
    await revalidate();
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
    const signedXdr = await wallet.sign(xdr, passphrase);
    const result = await api.submitTx({ xdr: signedXdr });
    if (result.status === "PENDING" || result.status === "OUTCOME_UNKNOWN") {
      throw new TransactionNotConfirmedError(result.status, result.hash);
    }
  }

  return { signAndSubmit, passphrase };
}
