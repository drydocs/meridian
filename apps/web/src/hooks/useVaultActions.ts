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
import { mapError } from "../lib/errorMapper";

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

export interface VaultTransactionPreview {
  operation: "deposit" | "withdraw";
  amount: string;
  asset: string;
  expectedResult: string;
  fee: string;
  minimumReceived: string;
}

interface PendingDeposit {
  operation: "deposit";
  xdr: string;
  preview: VaultTransactionPreview;
  vaultId: string;
  depositAmount: number;
  sharesBefore: number;
  depositedBefore: number;
  positionsBefore: ApiPosition[] | undefined;
  matchedBefore: ApiPosition | undefined;
}

interface PendingWithdraw {
  operation: "withdraw";
  xdr: string;
  preview: VaultTransactionPreview;
  vaultId: string;
  withdrawnShares: number;
  sharesBefore: number;
  positionsBefore: ApiPosition[] | undefined;
  matchedBefore: ApiPosition | undefined;
}

type PendingTransaction = PendingDeposit | PendingWithdraw;

export function useVaultActions() {
  const { t } = useTranslation();
  const { publicKey, network } = useWalletStore();
  const queryClient = useQueryClient();
  const { push } = useToastStore();
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [pendingTransaction, setPendingTransaction] =
    useState<PendingTransaction | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  const { signAndSubmit, passphrase } = useSignAndSubmit();
  const { hasRequiredTrustlines, addTrustline } = useTrustlines();
  const { hasBlendUsdcBalance, fundFromBlendFaucet } = useBlendFaucet();
  const { startPolling } = usePositionPolling();

  async function prepareDeposit(
    amount: string,
    vaultId: string,
    asset: string,
    minSharesOut?: string,
    riskAcknowledged?: boolean
  ): Promise<boolean> {
    if (!riskAcknowledged) return false;
    if (!publicKey || !passphrase) return false;
    setPendingTransaction(null);
    setSimulationError(null);
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
          throw new Error(t("vaultActions.vaultStateUnavailable"));
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
        if (!ok) throw new Error(t("vaultActions.preparationFailed"));
      }

      // On testnet, automatically fund the wallet from Blend's faucet when the
      // user has no USDC balance.
      if (APP_NETWORK.network === "testnet") {
        const hasFunds = await hasBlendUsdcBalance(publicKey, network);
        if (!hasFunds) {
          const ok = await fundFromBlendFaucet(publicKey, network);
          if (!ok) throw new Error(t("vaultActions.preparationFailed"));
        }
      }

      const { xdr, fee, simulationResult } = await api.buildDeposit({
        walletAddress: publicKey,
        vaultId,
        amount,
        min_shares_out: resolvedMinSharesOut,
        riskAcknowledged: true,
      });
      setPendingTransaction({
        operation: "deposit",
        xdr,
        preview: {
          operation: "deposit",
          amount,
          asset,
          expectedResult: simulationResult,
          fee,
          minimumReceived: resolvedMinSharesOut,
        },
        vaultId,
        depositAmount,
        sharesBefore,
        depositedBefore,
        positionsBefore,
        matchedBefore,
      });
      return true;
    } catch (err) {
      setSimulationError(
        mapError(err, t, "vaultActions.depositFailed").message
      );
      return false;
    } finally {
      setIsDepositing(false);
    }
  }

  async function prepareWithdraw(
    shares: string,
    vaultId: string,
    asset: string,
    minUsdcOut?: string
  ): Promise<boolean> {
    if (!publicKey || !passphrase) return false;
    setPendingTransaction(null);
    setSimulationError(null);
    setIsWithdrawing(true);
    try {
      // Snapshot the current positions before any async work so the optimistic
      // update and poll have a consistent baseline.
      const positionsBefore = queryClient.getQueryData<ApiPosition[]>([
        "positions",
        publicKey,
      ]);
      // Only this vault's position is a valid baseline. Falling back to
      // another vault would price the withdrawal against the wrong cost
      // basis and share count, so a missing match is treated as no baseline,
      // matching the deposit path.
      const matchedBefore = positionsBefore?.find((p) => p.vaultId === vaultId);
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
          throw new Error(t("vaultActions.vaultStateUnavailable"));
        }
        resolvedMinUsdcOut = computeMinUsdcOut({
          shares: parseFloat(shares),
          totalAssets: state.totalAssets,
          totalShares: state.totalShares,
          principal: estimatePrincipal(matchedBefore),
          positionShares: matchedBefore?.shares ?? 0,
        });
      }

      const { xdr, fee, simulationResult } = await api.buildWithdraw({
        walletAddress: publicKey,
        vaultId,
        shares,
        min_usdc_out: resolvedMinUsdcOut,
      });
      setPendingTransaction({
        operation: "withdraw",
        xdr,
        preview: {
          operation: "withdraw",
          amount: shares,
          asset,
          expectedResult: simulationResult,
          fee,
          minimumReceived: resolvedMinUsdcOut,
        },
        vaultId,
        withdrawnShares,
        sharesBefore,
        positionsBefore,
        matchedBefore,
      });
      return true;
    } catch (err) {
      setSimulationError(
        mapError(err, t, "vaultActions.withdrawalFailed").message
      );
      return false;
    } finally {
      setIsWithdrawing(false);
    }
  }

  async function confirmPrepared(): Promise<boolean> {
    if (!pendingTransaction || !publicKey || !passphrase) return false;
    const pending = pendingTransaction;
    const busy =
      pending.operation === "deposit" ? setIsDepositing : setIsWithdrawing;
    busy(true);
    try {
      await signAndSubmit(pending.xdr);
      queryClient.invalidateQueries({ queryKey: ["vaults"] });

      if (pending.operation === "deposit") {
        if (pending.matchedBefore && Number.isFinite(pending.depositAmount)) {
          const impliedSharePrice =
            pending.depositedBefore > 0
              ? pending.depositedBefore / pending.sharesBefore
              : 1;
          const sharesMinted = pending.depositAmount / impliedSharePrice;

          queryClient.setQueryData(
            ["positions", publicKey],
            (pending.positionsBefore ?? []).map((position) =>
              position === pending.matchedBefore
                ? {
                    ...position,
                    shares: pending.sharesBefore + sharesMinted,
                    deposited: pending.depositedBefore + pending.depositAmount,
                  }
                : position
            )
          );
        }
        startPolling(pending.vaultId, pending.sharesBefore, "increase");
        push(
          "success",
          `${t("vaultActions.deposited")} ${pending.preview.amount} ${pending.preview.asset}`
        );
      } else {
        if (
          pending.matchedBefore &&
          pending.withdrawnShares < pending.sharesBefore
        ) {
          const remainingRatio =
            (pending.sharesBefore - pending.withdrawnShares) /
            pending.sharesBefore;
          queryClient.setQueryData(
            ["positions", publicKey],
            (pending.positionsBefore ?? []).map((position) =>
              position === pending.matchedBefore
                ? {
                    ...position,
                    shares: pending.sharesBefore - pending.withdrawnShares,
                    deposited: position.deposited * remainingRatio,
                  }
                : position
            )
          );
        } else {
          queryClient.setQueryData(["positions", publicKey], []);
        }
        startPolling(pending.vaultId, pending.sharesBefore, "decrease");
        push(
          "success",
          `${t("vaultActions.withdrew")} ${pending.preview.amount} ${pending.preview.asset}`
        );
      }

      setPendingTransaction(null);
      return true;
    } catch (err) {
      push(
        "error",
        mapError(
          err,
          t,
          pending.operation === "deposit"
            ? "vaultActions.depositFailed"
            : "vaultActions.withdrawalFailed"
        ).message
      );
      return false;
    } finally {
      busy(false);
    }
  }

  function cancelPrepared() {
    setPendingTransaction(null);
    setSimulationError(null);
  }

  async function deposit(
    amount: string,
    vaultId: string,
    asset: string,
    minSharesOut?: string,
    riskAcknowledged?: boolean
  ): Promise<boolean> {
    return (
      (await prepareDeposit(
        amount,
        vaultId,
        asset,
        minSharesOut,
        riskAcknowledged
      )) && confirmPrepared()
    );
  }

  async function withdraw(
    shares: string,
    vaultId: string,
    asset: string,
    minUsdcOut?: string
  ): Promise<boolean> {
    return (
      (await prepareWithdraw(shares, vaultId, asset, minUsdcOut)) &&
      confirmPrepared()
    );
  }

  return {
    deposit,
    withdraw,
    prepareDeposit,
    prepareWithdraw,
    confirmPrepared,
    cancelPrepared,
    preview: pendingTransaction?.preview ?? null,
    simulationError,
    isDepositing,
    isWithdrawing,
  };
}
