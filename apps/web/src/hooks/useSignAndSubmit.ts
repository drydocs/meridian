import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { wallet, type WalletOperationOptions } from "../lib/wallet";
import { api } from "../lib/api";
import { useTranslation } from "react-i18next";

export function useSignAndSubmit() {
  const { t } = useTranslation();
  const { revalidate } = useWalletStore();
  // The passphrase is a build-time invariant, not user state. Sourcing it from
  // APP_NETWORK avoids the stale-persisted-network bug (#851) where the store
  // could hold "testnet" on a mainnet build and cause xBull to sign against
  // the wrong network hash.
  const passphrase = APP_NETWORK.passphrase;

  // `options` carries the caller's abort signal and timeout override, so a
  // deposit or withdrawal can be cancelled while the wallet popup is open
  // (#1301). Without one, the adapter's own sign deadline still applies.
  async function signAndSubmit(xdr: string, options?: WalletOperationOptions) {
    await revalidate();
    if (!useWalletStore.getState().connected) {
      throw new Error(t("walletConnect.walletDisconnected"));
    }
    const signedXdr = options
      ? await wallet.sign(xdr, passphrase, options)
      : await wallet.sign(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

  return { signAndSubmit, passphrase };
}
