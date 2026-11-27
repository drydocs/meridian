import {
  APP_NETWORK,
  DepositRequestSchema,
  WithdrawRequestSchema,
  TrustlineRequestSchema,
  SubmitRequestSchema,
  QuoteRequestSchema,
  DEFAULT_SLIPPAGE_BPS,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
  ContractSimulationError,
  assertRequiredTrustlines,
  MissingTrustlineError,
  quoteVaultAction,
  TransactionOutcomeUnknownError,
} from "@meridian/stellar-sdk-helpers";
import { UpstreamDeadlineError } from "@meridian/shared";
import { trackPositionHistoryUser } from "./position-tracking";
import type { RouteResult } from "./types";
import {
  deadlineResult,
  UPSTREAM_TIMEOUT_MS,
  withUpstreamDeadline,
} from "./deadline";

/**
 * Vault ContractError discriminants that the caller can correct (slippage,
 * pause, balance) rather than server/infrastructure failures.
 * Source: packages/contracts/vault/src/errors.rs
 * Note: vault has DepositsPaused but no WithdrawalsPaused variant.
 */
const USER_FIXABLE_CONTRACT_ERRORS: Record<number, string> = {
  3: "Deposits are currently paused. Try again later.",
  7: "Insufficient shares for this withdrawal.",
  15: "Withdrawal returned less USDC than your minimum. Adjust slippage and retry.",
  18: "Slippage tolerance exceeded. Adjust slippage and retry.",
  41: "Insufficient liquidity in the underlying yield protocol for this withdrawal. Try a smaller amount or retry later.",
};

/**
 * Transaction errors safe to relay to API callers. Everything else returns the
 * route's generic fallback so SDK diagnostics and assertion text stay in logs.
 */
const CALLER_FACING_TX_ERRORS = new Set([
  "All required trustlines already exist",
  "USDC trustline missing",
]);

const CONTRACT_ERROR_CODE = /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/i;

function contractErrorCode(err: unknown): number | undefined {
  if (err instanceof ContractSimulationError) return err.code;
  if (err instanceof Error) {
    const match = err.message.match(CONTRACT_ERROR_CODE);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

/** Map user-fixable contract rejections to HTTP 400; everything else stays 500. */
function txErrorResult(err: unknown, fallback: string): RouteResult {
  const code = contractErrorCode(err);
  if (code !== undefined) {
    const friendly = USER_FIXABLE_CONTRACT_ERRORS[code];
    if (friendly) {
      return { status: 400, body: { error: friendly }, error: err };
    }
  }
  const message = sanitizeTxError(err, fallback);
  return {
    status: 500,
    body: {
      error: CALLER_FACING_TX_ERRORS.has(message) ? message : fallback,
    },
    error: err,
  };
}

function txFailureResult(err: unknown, fallback: string): RouteResult {
  return err instanceof UpstreamDeadlineError
    ? deadlineResult(err, fallback)
    : txErrorResult(err, fallback);
}

export async function handleDepositRequest(
  body: unknown
): Promise<RouteResult> {
  const parsed = DepositRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const { walletAddress, vaultId, amount, min_shares_out } = parsed.data;
    const result = await withUpstreamDeadline(async () => {
      await assertRequiredTrustlines(walletAddress, APP_NETWORK);
      let protectedMinimum = min_shares_out;
      if (!protectedMinimum) {
        const quote = await quoteVaultAction({
          action: "deposit",
          walletAddress,
          vaultId,
          amount,
          network: APP_NETWORK,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        });
        protectedMinimum = quote.recommendedMinimum;
      }
      return buildDepositTx(
        vaultId,
        walletAddress,
        amount,
        APP_NETWORK,
        protectedMinimum
      );
    }, "deposit preparation");
    await trackPositionHistoryUser(walletAddress);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof MissingTrustlineError) {
      return { status: 400, body: { error: err.message }, error: err };
    }
    return txFailureResult(err, "Failed to build deposit transaction");
  }
}

export async function handleWithdrawRequest(
  body: unknown
): Promise<RouteResult> {
  const parsed = WithdrawRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const { walletAddress, vaultId, shares, min_usdc_out } = parsed.data;
    const result = await withUpstreamDeadline(async () => {
      await assertRequiredTrustlines(walletAddress, APP_NETWORK);
      let protectedMinimum = min_usdc_out;
      if (!protectedMinimum) {
        const quote = await quoteVaultAction({
          action: "withdraw",
          walletAddress,
          vaultId,
          shares,
          network: APP_NETWORK,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        });
        protectedMinimum = quote.recommendedMinimum;
      }
      return buildWithdrawTx(
        vaultId,
        walletAddress,
        shares,
        APP_NETWORK,
        protectedMinimum
      );
    }, "withdraw preparation");
    await trackPositionHistoryUser(walletAddress);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof MissingTrustlineError) {
      return { status: 400, body: { error: err.message }, error: err };
    }
    return txFailureResult(err, "Failed to build withdraw transaction");
  }
}

export async function handleAddTrustlineRequest(
  body: unknown
): Promise<RouteResult> {
  const parsed = TrustlineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const result = await withUpstreamDeadline(
      () => buildAddTrustlineTx(parsed.data.walletAddress, APP_NETWORK),
      "trustline transaction"
    );
    return { status: 200, body: result };
  } catch (err) {
    return txFailureResult(err, "Failed to build trustline transaction");
  }
}

export async function handleSubmitRequest(body: unknown): Promise<RouteResult> {
  const parsed = SubmitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    // Do not race a signed submission against the request deadline. The RPC
    // helper waits for normal ledger confirmation and returns 202 only when
    // the transaction was accepted but its final outcome could not be read.
    const result = await submitTx(parsed.data.xdr, APP_NETWORK, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
    if (result.status === "PENDING") {
      return {
        status: 202,
        body: {
          hash: result.hash,
          status: "PENDING",
        },
      };
    }
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof TransactionOutcomeUnknownError) {
      return {
        status: 202,
        body: {
          hash: err.hash,
          status: "OUTCOME_UNKNOWN",
          code: err.code,
        },
        error: err,
      };
    }
    return txFailureResult(err, "Failed to submit transaction");
  }
}

export async function handleQuoteRequest(body: unknown): Promise<RouteResult> {
  const parsed = QuoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const { action, walletAddress, vaultId, amount, shares } = parsed.data;
    const quote = await withUpstreamDeadline(
      () =>
        quoteVaultAction({
          action,
          walletAddress,
          vaultId,
          amount,
          shares,
          network: APP_NETWORK,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        }),
      "transaction quote"
    );
    return { status: 200, body: quote };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Deposits are currently paused"
    ) {
      return { status: 400, body: { error: err.message }, error: err };
    }
    return txFailureResult(err, "Failed to simulate transaction quote");
  }
}
