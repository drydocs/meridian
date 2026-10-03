import {
  APP_NETWORK,
  DepositRequestSchema,
  WithdrawRequestSchema,
  TrustlineRequestSchema,
  SubmitRequestSchema,
  formatZodError,
  sanitizeTxError,
} from "@meridian/shared";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
  ContractSimulationError,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

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
};

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
  return {
    status: 500,
    body: { error: sanitizeTxError(err, fallback) },
    error: err,
  };
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
    const result = await buildDepositTx(
      vaultId,
      walletAddress,
      amount,
      APP_NETWORK,
      min_shares_out
    );
    return { status: 200, body: result };
  } catch (err) {
    return txErrorResult(err, "Failed to build deposit transaction");
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
    const result = await buildWithdrawTx(
      vaultId,
      walletAddress,
      shares,
      APP_NETWORK,
      min_usdc_out
    );
    return { status: 200, body: result };
  } catch (err) {
    return txErrorResult(err, "Failed to build withdraw transaction");
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
    const result = await buildAddTrustlineTx(
      parsed.data.walletAddress,
      APP_NETWORK
    );
    return { status: 200, body: result };
  } catch (err) {
    return txErrorResult(err, "Failed to build trustline transaction");
  }
}

export async function handleSubmitRequest(body: unknown): Promise<RouteResult> {
  const parsed = SubmitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  try {
    const result = await submitTx(parsed.data.xdr, APP_NETWORK);
    return { status: 200, body: result };
  } catch (err) {
    return txErrorResult(err, "Failed to submit transaction");
  }
}
