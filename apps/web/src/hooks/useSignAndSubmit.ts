import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { wallet } from "../lib/wallet";
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

  async function signAndSubmit(xdr: string) {
    await revalidate();
    if (!useWalletStore.getState().connected) {
      throw new Error(t("walletConnect.walletDisconnected"));
    }
    const signedXdr = await wallet.sign(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

  return { signAndSubmit, passphrase };
}
