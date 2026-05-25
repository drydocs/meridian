import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletStore } from "../store/wallet";
import { signTransaction } from "../lib/wallet";
import { api } from "../lib/api";

const NETWORK_PASSPHRASE: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

export function useVaultActions() {
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runTx(key: string, buildFn: (caller: string) => Promise<{ xdr: string }>) {
    if (!publicKey) throw new Error("Wallet not connected");
    const passphrase = NETWORK_PASSPHRASE[network];
    if (!passphrase) throw new Error(`Unknown network: ${network}`);
    setError(null);
    const { xdr } = await buildFn(publicKey);
    const signedXdr = await signTransaction(xdr, passphrase);
    await api.submitTx({ xdr: signedXdr });
    queryClient.invalidateQueries({ queryKey: ["positions", key] });
  }

  async function deposit(amount: string) {
    setIsDepositing(true);
    try {
      await runTx(publicKey!, (caller) => api.buildDeposit({ caller, amount }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit failed");
    } finally {
      setIsDepositing(false);
    }
  }

  async function withdraw(shares: string) {
    setIsWithdrawing(true);
    try {
      await runTx(publicKey!, (caller) => api.buildWithdraw({ caller, shares }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal failed");
    } finally {
      setIsWithdrawing(false);
    }
  }

  return { deposit, withdraw, isDepositing, isWithdrawing, error, clearError: () => setError(null) };
}
