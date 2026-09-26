import { useQuery } from "@tanstack/react-query";
import { DEFAULT_SLIPPAGE_BPS } from "@meridian/shared";
import { api, type VaultState } from "../lib/api";

const STALE_TIME_MS = 30_000;

/**
 * On-demand read of live vault totals (`get_total_assets` /
 * `get_total_shares` via the vault-state API). Bypasses react-query cache so
 * deposit/withdraw slippage floors are computed from current on-chain state
 * rather than a stale position share price.
 */
export async function fetchFreshVaultState(): Promise<VaultState> {
  return api.getVaultState();
}

/** Shares expected for `amount` USDC at the live vault share price, with slippage haircut. */
export function computeMinSharesOut(
  amount: number,
  totalAssets: number,
  totalShares: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): string | undefined {
  if (
    !(
      Number.isFinite(amount) &&
      amount > 0 &&
      Number.isFinite(totalAssets) &&
      totalAssets > 0 &&
      Number.isFinite(totalShares) &&
      totalShares > 0
    )
  ) {
    return undefined;
  }
  const slippageFactor = 1 - slippageBps / 10_000;
  return Math.max(
    0,
    ((amount * totalShares) / totalAssets) * slippageFactor
  ).toFixed(7);
}

/** USDC expected for `shares` at the live vault share price, with slippage haircut. */
export function computeMinUsdcOut(
  shares: number,
  totalAssets: number,
  totalShares: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): string | undefined {
  if (
    !(
      Number.isFinite(shares) &&
      shares > 0 &&
      Number.isFinite(totalAssets) &&
      totalAssets > 0 &&
      Number.isFinite(totalShares) &&
      totalShares > 0
    )
  ) {
    return undefined;
  }
  const slippageFactor = 1 - slippageBps / 10_000;
  return Math.max(
    0,
    ((shares * totalAssets) / totalShares) * slippageFactor
  ).toFixed(7);
}

export function useVaultState() {
  return useQuery({
    queryKey: ["vault-state"],
    queryFn: () => api.getVaultState(),
    staleTime: STALE_TIME_MS,
    retry: 1,
  });
}
