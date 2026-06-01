import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletStore } from "../store/wallet";
import { signTransaction } from "../lib/wallet";
import { api } from "../lib/api";
import { useToastStore } from "../store/toast";

const NETWORK_PASSPHRASE: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

function isMissingTrustline(msg: string) {
  return msg.toLowerCase().includes("trustline");
}

export function useVaultActions() {
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsTrustline, setNeedsTrustline] = useState(false);

  const passphrase = NETWORK_PASSPHRASE[network];

  async function signAndSubmit(xdr: string) {
    const signedXdr = await signTransaction(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
  }

  async function addTrustline(): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    try {
      const { xdr } = await api.addTrustline(publicKey);
      await signAndSubmit(xdr);
      setNeedsTrustline(false);
      setError(null);
      push("success", "Vault assets added to wallet");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add vault assets";
      setError(msg);
      push("error", msg);
      return false;
    }
  }

  async function deposit(amount: string, vaultId: string): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsDepositing(true);
    setError(null);
    try {
      const { xdr } = await api.buildDeposit({ walletAddress: publicKey, vaultId, amount });
      await signAndSubmit(xdr);
      setNeedsTrustline(false);
      queryClient.invalidateQueries({ queryKey: ["positions", publicKey] });
      push("success", `Deposited ${amount} USDC`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Deposit failed";
      if (isMissingTrustline(msg)) {
        setNeedsTrustline(true);
        setError("Your wallet is missing a required trustline. Click below to add it, then try again.");
      } else {
        setError(msg);
        push("error", msg);
      }
      return false;
    } finally {
      setIsDepositing(false);
    }
  }

  async function withdraw(shares: string, vaultId: string): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsWithdrawing(true);
    setError(null);
    try {
      const { xdr } = await api.buildWithdraw({ walletAddress: publicKey, vaultId, shares });
      await signAndSubmit(xdr);
      queryClient.invalidateQueries({ queryKey: ["positions", publicKey] });
      push("success", `Withdrew ${shares} mUSDC`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Withdrawal failed";
      setError(msg);
      push("error", msg);
      return false;
    } finally {
      setIsWithdrawing(false);
    }
  }

  return {
    deposit,
    withdraw,
    addTrustline,
    needsTrustline,
    isDepositing,
    isWithdrawing,
    error,
    clearError: () => { setError(null); setNeedsTrustline(false); },
  };
}
