import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { STELLAR_NETWORKS } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { signTransaction } from "../lib/wallet";
import { api } from "../lib/api";
import { useToastStore } from "../store/toast";

function isMissingTrustline(msg: string) {
  return msg.toLowerCase().includes("trustline");
}

export function useVaultActions() {
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [needsTrustline, setNeedsTrustline] = useState(false);

  const passphrase = STELLAR_NETWORKS[network as keyof typeof STELLAR_NETWORKS]?.passphrase;

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
      push("success", "Vault assets added to wallet");
      return true;
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Failed to add vault assets");
      return false;
    }
  }

  async function deposit(amount: string, vaultId: string, asset: string): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsDepositing(true);
    try {
      const { xdr } = await api.buildDeposit({ walletAddress: publicKey, vaultId, amount });
      await signAndSubmit(xdr);
      setNeedsTrustline(false);
      queryClient.invalidateQueries({ queryKey: ["positions", publicKey] });
      push("success", `Deposited ${amount} ${asset}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Deposit failed";
      if (isMissingTrustline(msg)) {
        setNeedsTrustline(true);
      }
      push("error", msg);
      return false;
    } finally {
      setIsDepositing(false);
    }
  }

  async function withdraw(shares: string, vaultId: string, asset: string): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsWithdrawing(true);
    try {
      const { xdr } = await api.buildWithdraw({ walletAddress: publicKey, vaultId, shares });
      await signAndSubmit(xdr);
      queryClient.invalidateQueries({ queryKey: ["positions", publicKey] });
      push("success", `Withdrew ${shares} ${asset}`);
      return true;
    } catch (err) {
      push("error", err instanceof Error ? err.message : "Withdrawal failed");
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
    clearNeedsTrustline: () => setNeedsTrustline(false),
  };
}
