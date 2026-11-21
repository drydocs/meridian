import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { wallet } from "../lib/wallet";
import { api } from "../lib/api";
import { WALLET_DISCONNECTED_ERROR } from "../lib/errorMapper";

export function useSignAndSubmit() {
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
    const signedXdr = await wallet.sign(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

  return { signAndSubmit, passphrase };
}
