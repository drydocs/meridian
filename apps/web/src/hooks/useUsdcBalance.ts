import { useCallback, useEffect, useState } from "react";
import { USDC_ISSUER } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { fetchBalances } from "../lib/horizonAccount";

export interface UseUsdcBalanceResult {
  /** The wallet's spendable USDC, or undefined when unknown (skip guard). */
  balance: number | undefined;
  /** True when reading the balance from Horizon failed. */
  isError?: boolean;
  /** Re-fetch the balance — call this after a deposit succeeds. */
  refetch: () => void;
}

/**
 * Reads the spendable USDC balance for the given account from Horizon.
 * Deducts selling liabilities if present. Returns undefined when no USDC
 * issuer is configured for the network.
 * Throws when Horizon returns non-ok or the account cannot be read.
 */
export async function fetchSpendableBalance(
  publicKey: string,
  network: string
): Promise<number | undefined> {
  const account = await fetchBalances(publicKey, network);
  if (!account) {
    throw new Error(`Failed to fetch balance from Horizon for ${publicKey}`);
  }

  const issuer = USDC_ISSUER[network];
  if (!issuer) return undefined;
  const usdc = account.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === issuer
  );

  if (!usdc) return 0;

  const rawBalance = parseFloat(usdc.balance);
  if (Number.isNaN(rawBalance)) return 0;

  const liabilities = parseFloat(
    (usdc as { selling_liabilities?: string }).selling_liabilities ?? "0"
  );
  const sellingLiabilities = Number.isNaN(liabilities) ? 0 : liabilities;

  return Math.max(0, rawBalance - sellingLiabilities);
}

/**
 * Reads the connected wallet's spendable USDC balance from Horizon — the same source
 * that `hasRequiredTrustlines` in `useTrustlines` uses for the deposit's
 * trustline check (see #1063).
 *
 * Returns:
 *   - `balance: undefined` while loading, when no wallet is connected, or
 *     on a network/Horizon error.
 *   - `balance: number` (>= 0) spendable USDC (net of selling liabilities).
 *   - `isError: true` when Horizon reading fails (for retryable UI).
 *   - `refetch()` to force a fresh Horizon read.
 */
export function useUsdcBalance(): UseUsdcBalanceResult {
  const { publicKey, network } = useWalletStore();
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [isError, setIsError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Reset via microtask so we don't trigger a synchronous setState in
    // the effect body (react-hooks/set-state-in-effect).
    if (!publicKey) {
      queueMicrotask(() => {
        if (!cancelled) {
          setBalance(undefined);
          setIsError(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        setIsError(false);
        const spendable = await fetchSpendableBalance(publicKey, network);
        if (cancelled) return;
        setBalance(spendable);
      } catch {
        if (!cancelled) {
          setBalance(undefined);
          setIsError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey, network, nonce]);

  return { balance, isError, refetch };
}
