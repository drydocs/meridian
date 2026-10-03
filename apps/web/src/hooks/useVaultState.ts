import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_SLIPPAGE_BPS,
  VAULT_PERFORMANCE_FEE_BPS,
} from "@meridian/shared";
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
  if (!(
    Number.isFinite(amount) &&
    amount > 0 &&
    Number.isFinite(totalAssets) &&
    totalAssets > 0 &&
    Number.isFinite(totalShares) &&
    totalShares > 0
  )) {
    return undefined;
  }
  const slippageFactor = 1 - slippageBps / 10_000;
  return Math.max(
    0,
    ((amount * totalShares) / totalAssets) * slippageFactor
  ).toFixed(7);
}

export interface MinUsdcOutInput {
  /** Shares being burned. */
  shares: number;
  /** Live vault totals, from `get_total_assets` / `get_total_shares`. */
  totalAssets: number;
  totalShares: number;
  /**
   * The position's on-chain cost basis. The contract prorates it across the
   * shares being burned, so it needs the position's full share balance too.
   * Pass 0 when no basis is known, which prices the whole withdrawal as gain.
   */
  principal: number;
  positionShares: number;
  slippageBps?: number;
}

/**
 * USDC expected for `shares` at the live vault share price, net of the
 * withdrawal performance fee, with slippage haircut.
 *
 * The contract charges the fee and only then enforces `min_usdc_out`
 * (`packages/contracts/vault/src/lib.rs`), so the floor has to be priced
 * against what the caller actually receives. A gross floor reverts with
 * `MinAmountOutNotMet` once accrued gain passes roughly 5% of principal.
 *
 * The pre-fee vault still deployed on mainnet charges nothing, where this
 * prices a slightly looser floor than before. That is the safe direction: the
 * floor is only ever weaker, never high enough to revert a valid withdrawal.
 */
export function computeMinUsdcOut({
  shares,
  totalAssets,
  totalShares,
  principal,
  positionShares,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
}: MinUsdcOutInput): string | undefined {
  if (!(
    Number.isFinite(shares) &&
    shares > 0 &&
    Number.isFinite(totalAssets) &&
    totalAssets > 0 &&
    Number.isFinite(totalShares) &&
    totalShares > 0
  )) {
    return undefined;
  }

  const grossUsdcOut = (shares * totalAssets) / totalShares;
  const principalOut =
    Number.isFinite(principal) &&
    principal > 0 &&
    Number.isFinite(positionShares) &&
    positionShares > 0
      ? (principal * shares) / positionShares
      : 0;
  const gain = Math.max(0, grossUsdcOut - principalOut);
  const fee = (gain * VAULT_PERFORMANCE_FEE_BPS) / 10_000;
  const slippageFactor = 1 - slippageBps / 10_000;

  return Math.max(0, (grossUsdcOut - fee) * slippageFactor).toFixed(7);
}

export function useVaultState() {
  return useQuery({
    queryKey: ["vault-state"],
    queryFn: () => api.getVaultState(),
    staleTime: STALE_TIME_MS,
    retry: 1,
  });
}
