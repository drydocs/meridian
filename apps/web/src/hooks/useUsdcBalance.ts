import { useCallback, useEffect, useState } from "react";
import { USDC_ISSUER } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { fetchBalances } from "../lib/horizonAccount";

export interface UseUsdcBalanceResult {
  /** The wallet's spendable USDC, or undefined when unknown (skip guard). */
  balance: number | undefined;
  /** Re-fetch the balance — call this after a deposit succeeds. */
  refetch: () => void;
}

/**
 * Reads the connected wallet's USDC balance from Horizon — the same source
 * that `hasRequiredTrustlines` in `useTrustlines` uses for the deposit's
 * trustline check (see #1063).
 *
 * Returns:
 *   - `balance: undefined` while loading, when no wallet is connected, or
 *     on a network/Horizon error. Callers gating submit on the value must
 *     treat `undefined` as "no opinion" (do not block), matching the
 *     DepositTab contract where `availableBalance` is optional.
 *   - `balance: number` (>= 0) when the account exists and holds a USDC
 *     trustline.
 *   - `refetch()` to force a fresh Horizon read — e.g. after a deposit
 *     changes the balance.
 */
export function useUsdcBalance(): UseUsdcBalanceResult {
  const { publicKey, network } = useWalletStore();
  const [balance, setBalance] = useState<number | undefined>(undefined);
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
        if (!cancelled) setBalance(undefined);
      });
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const account = await fetchBalances(publicKey, network);
        if (cancelled) return;
        if (!account) {
          setBalance(undefined);
          return;
        }
        const usdcIssuer = USDC_ISSUER[network];
        if (!usdcIssuer) {
          setBalance(undefined);
          return;
        }
        const usdc = account.balances.find(
          (b) => b.asset_code === "USDC" && b.asset_issuer === usdcIssuer
        );
        if (!usdc) {
          setBalance(undefined);
          return;
        }
        const parsed = Number(usdc.balance);
        setBalance(Number.isFinite(parsed) ? parsed : undefined);
      } catch {
        if (!cancelled) setBalance(undefined);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey, network, nonce]);

  return { balance, refetch };
}
