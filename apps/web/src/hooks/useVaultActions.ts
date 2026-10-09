import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { APP_NETWORK } from "@meridian/shared";
import { useWalletStore } from "../store/wallet";
import { api, type ApiPosition, type VaultState } from "../lib/api";
import { useToastStore } from "../store/toast";
import { useSignAndSubmit } from "./useSignAndSubmit";
import { useTrustlines } from "./useTrustlines";
import { useBlendFaucet } from "./useBlendFaucet";
import { usePositionPolling } from "./usePositionPolling";
import { useTranslation } from "react-i18next";
import {
  computeMinSharesOut,
  computeMinUsdcOut,
  fetchFreshVaultState,
} from "./useVaultState";

/**
 * Live vault totals for pricing a slippage floor, falling back to the cached
 * read when the fresh one fails. Returns undefined when neither is available,
 * which callers must treat as "no floor can be priced" rather than submitting
 * an unprotected transaction.
 */
async function resolveVaultState(
  queryClient: QueryClient
): Promise<VaultState | undefined> {
  try {
    const fresh = await fetchFreshVaultState();
    queryClient.setQueryData(["vault-state"], fresh);
    return fresh;
  } catch (err) {
    console.warn("[vault-actions] fresh vault state read failed", err);
  }
  return queryClient.getQueryData<VaultState>(["vault-state"]);
}

/**
 * The position's on-chain cost basis, which the vault needs to work out the
 * performance fee. `deposited` is the position's current value and `earned`
 * the yield above that basis, so the basis is their difference.
 */
function estimatePrincipal(position: ApiPosition | undefined): number {
  if (!position) return 0;
  return Math.max(0, position.deposited - position.earned);
}

export function useVaultActions() {
  const { t } = useTranslation();
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);

  const { signAndSubmit, passphrase } = useSignAndSubmit();
  const { hasRequiredTrustlines, addTrustline } = useTrustlines();
  const { hasBlendUsdcBalance, fundFromBlendFaucet } = useBlendFaucet();
  const { startPolling } = usePositionPolling();

  async function deposit(
    amount: string,
    vaultId: string,
    asset: string,
    minSharesOut?: string,
    riskAcknowledged?: boolean
  ): Promise<boolean> {
    if (!riskAcknowledged) return false;
    if (!publicKey || !passphrase) return false;
    setIsDepositing(true);
    try {
      // Snapshot the cached positions before any async work so the optimistic
      // update and the poll share a baseline, the same shape as `withdraw`.
      const positionsBefore = queryClient.getQueryData<ApiPosition[]>([
        "positions",
        publicKey,
      ]);
      const matchedBefore = positionsBefore?.find((p) => p.vaultId === vaultId);
      const sharesBefore = matchedBefore?.shares ?? Infinity;
      const depositedBefore = matchedBefore?.deposited ?? 0;
      const depositAmount = parseFloat(amount);

      // Price the floor before anything that costs a signature, so a vault
      // state outage fails the deposit outright instead of leaving it to
      // submit unprotected. Prefer an explicit floor (tests / callers), then
      // live vault totals rather than the cached position share price, which
      // lags yield accrual and understates the floor.
      let resolvedMinSharesOut = minSharesOut;
      if (resolvedMinSharesOut === undefined) {
        const state = await resolveVaultState(queryClient);
        if (!state) {
          push("error", t("vaultActions.vaultStateUnavailable"));
          return false;
        }
        resolvedMinSharesOut = computeMinSharesOut(
          parseFloat(amount),
          state.totalAssets,
          state.totalShares
        );
      }

      // Establish any missing trustline(s) first, silently, before the user
      // has any reason to expect more than one signature — same one-click,
      // two-signature shape as the faucet funding step below.
      const hasTrustlines = await hasRequiredTrustlines(publicKey, network);
      if (!hasTrustlines) {
        const ok = await addTrustline();
        if (!ok) return false;
      }

      // On testnet, automatically fund the wallet from Blend's faucet when the
      // user has no USDC balance.
      if (APP_NETWORK.network === "testnet") {
        const hasFunds = await hasBlendUsdcBalance(publicKey, network);
        if (!hasFunds) {
          const ok = await fundFromBlendFaucet(publicKey, network);
          if (!ok) return false;
        }
      }

      const { xdr } = await api.buildDeposit({
        walletAddress: publicKey,
        vaultId,
        amount,
        min_shares_out: resolvedMinSharesOut,
        riskAcknowledged: true,
      });
      await signAndSubmit(xdr);

      // Without this, the vault panel's TVL/APY keep serving their cached
      // value for up to staleTime (5 min) after a deposit actually lands.
      queryClient.invalidateQueries({ queryKey: ["vaults"] });

      // Optimistically raise the position in-place so the position card
      // reflects the deposit immediately instead of waiting for the async
      // balance/indexer to catch up. Skipped when there is no cached entry,
      // since we won't fabricate a position we never had.
      if (matchedBefore && Number.isFinite(depositAmount)) {
        // A vault share is not one USDC. Once yield accrues the share price
        // rises above 1.0, so `depositAmount` USDC mints fewer than
        // `depositAmount` shares, and crediting the raw amount would overstate
        // the position for the whole optimistic window. Convert through the
        // implied share price (`deposited / shares`). Inside this block
        // `sharesBefore` is a positive share count, so the only case with no
        // price to derive is a position with no prior deposit, which falls
        // back to 1:1.
        const impliedSharePrice =
          depositedBefore > 0 ? depositedBefore / sharesBefore : 1;
        const sharesMinted = depositAmount / impliedSharePrice;

        queryClient.setQueryData(
          ["positions", publicKey],
          (positionsBefore ?? []).map((p) =>
            p === matchedBefore
              ? {
                  ...p,
                  shares: sharesBefore + sharesMinted,
                  deposited: depositedBefore + depositAmount,
                }
              : p
          )
        );
      }

      // Hand off to position polling - it re-checks every 3s, stops once the
      // live share count rises above sharesBefore, and gives up after 30s.
      startPolling(vaultId, sharesBefore, "increase");

      push("success", `${t("vaultActions.deposited")} ${amount} ${asset}`);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : t("vaultActions.depositFailed");
      push("error", msg);
      return false;
    } finally {
      setIsDepositing(false);
    }
  }

  async function withdraw(
    shares: string,
    vaultId: string,
    asset: string,
    minUsdcOut?: string
  ): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setIsWithdrawing(true);
    try {
      // Snapshot the current positions before any async work so the optimistic
      // update and poll have a consistent baseline.
      const positionsBefore = queryClient.getQueryData<ApiPosition[]>([
        "positions",
        publicKey,
      ]);
      const matchedBefore =
        positionsBefore?.find((p) => p.vaultId === vaultId) ??
        positionsBefore?.[0];
      const sharesBefore = matchedBefore?.shares ?? Infinity;
      const withdrawnShares = parseFloat(shares);

      // Price the floor from live vault totals, net of the performance fee the
      // vault charges before it enforces the floor. Failing to price one must
      // not submit the withdrawal unprotected, since bounding the cost of a
      // ratio shift is the whole point of the floor.
      let resolvedMinUsdcOut = minUsdcOut;
      if (resolvedMinUsdcOut === undefined) {
        const state = await resolveVaultState(queryClient);
        if (!state) {
          push("error", t("vaultActions.vaultStateUnavailable"));
          return false;
        }
        resolvedMinUsdcOut = computeMinUsdcOut({
          shares: parseFloat(shares),
          totalAssets: state.totalAssets,
          totalShares: state.totalShares,
          principal: estimatePrincipal(matchedBefore),
          positionShares: matchedBefore?.shares ?? 0,
        });
      }

      const { xdr } = await api.buildWithdraw({
        walletAddress: publicKey,
        vaultId,
        shares,
        min_usdc_out: resolvedMinUsdcOut,
      });

      await signAndSubmit(xdr);

      // Without this, the vault panel's TVL/APY keep serving their cached
      // value for up to staleTime (5 min) after a withdrawal actually lands.
      queryClient.invalidateQueries({ queryKey: ["vaults"] });

      // Optimistic update: partial withdrawal scales the position down in-place
      // so the position card stays visible with an approximate remaining balance.
      // Full withdrawal (or no prior data) clears the cache entirely.
      if (matchedBefore && withdrawnShares < sharesBefore) {
        const remainingRatio = (sharesBefore - withdrawnShares) / sharesBefore;
        queryClient.setQueryData(
          ["positions", publicKey],
          (positionsBefore ?? []).map((p) =>
            p === matchedBefore
              ? {
                  ...p,
                  shares: sharesBefore - withdrawnShares,
                  deposited: p.deposited * remainingRatio,
                }
              : p
          )
        );
      } else {
        queryClient.setQueryData(["positions", publicKey], []);
      }

      // Hand off to position polling - it re-checks every 3s, stops once
      // this withdrawal's live share count drops below sharesBefore, and
      // gives up after 30s.
      startPolling(vaultId, sharesBefore, "decrease");

      push("success", `${t("vaultActions.withdrew")} ${shares} ${asset}`);
      return true;
    } catch (err) {
      push(
        "error",
        err instanceof Error ? err.message : t("vaultActions.withdrawalFailed")
      );
      return false;
    } finally {
      setIsWithdrawing(false);
    }
  }

  return {
    deposit,
    withdraw,
    isDepositing,
    isWithdrawing,
  };
}
