import {
  APP_NETWORK,
  DepositRequestSchema,
  WithdrawRequestSchema,
  TrustlineRequestSchema,
  SubmitRequestSchema,
  formatZodError,
  sanitizeTxError,
  STELLAR_NETWORKS,
} from "@meridian/shared";
import {
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  submitTx,
  TransactionFailedError,
  ContractSimulationError,
  assertRequiredTrustlines,
  MissingTrustlineError,
  getTransactionForReconciliation,
  type StellarNetwork,
} from "@meridian/stellar-sdk-helpers";
import { trackPositionHistoryUser } from "./position-tracking";
import type { RouteResult } from "./types";
import {
  beginIdempotentSubmission,
  hashValidatedRequest,
  reconcileIdempotentSubmission,
  runNonTransactionIdempotently,
  type IdempotencyResult,
  type IdempotencyResponse,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredIdempotencyRecord,
  type SubmissionObservation,
  type SubmissionClaimResult,
  type UnknownSubmissionRecord,
} from "./idempotency";
import { loadIdempotencyStore } from "./idempotency-upstash";

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

export async function handleDepositRequest(
  body: unknown,
  options: BuildRequestOptions = {}
): Promise<RouteResult> {
  const parsed = DepositRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  return runBuildIdempotently(parsed.data, options, async () => { try {
    const { walletAddress, vaultId, amount, min_shares_out } = parsed.data;
    await assertRequiredTrustlines(walletAddress, APP_NETWORK);
    const result = await buildDepositTx(
      vaultId,
      walletAddress,
      amount,
      APP_NETWORK,
      min_shares_out
    );
    await trackPositionHistoryUser(walletAddress);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof MissingTrustlineError) {
      return { status: 400, body: { error: err.message }, error: err };
    }
    return txErrorResult(err, "Failed to build deposit transaction");
  } });
}

export async function handleWithdrawRequest(
  body: unknown,
  options: BuildRequestOptions = {}
): Promise<RouteResult> {
  const parsed = WithdrawRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  return runBuildIdempotently(parsed.data, options, async () => { try {
    const { walletAddress, vaultId, shares, min_usdc_out } = parsed.data;
    await assertRequiredTrustlines(walletAddress, APP_NETWORK);
    const result = await buildWithdrawTx(
      vaultId,
      walletAddress,
      shares,
      APP_NETWORK,
      min_usdc_out
    );
    await trackPositionHistoryUser(walletAddress);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof MissingTrustlineError) {
      return { status: 400, body: { error: err.message }, error: err };
    }
    return txErrorResult(err, "Failed to build withdraw transaction");
  } });
}

export async function handleAddTrustlineRequest(
  body: unknown,
  options: BuildRequestOptions = {}
): Promise<RouteResult> {
  const parsed = TrustlineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  return runBuildIdempotently(parsed.data, options, async () => { try {
    const result = await buildAddTrustlineTx(
      parsed.data.walletAddress,
      APP_NETWORK
    );
    return { status: 200, body: result };
  } catch (err) {
    return txErrorResult(err, "Failed to build trustline transaction");
  } });
}

export interface BuildRequestOptions {
  idempotencyKey?: string;
  store?: IdempotencyStore;
}

function idempotencyResult(result: IdempotencyResult): RouteResult {
  if (result.kind === "executed" || result.kind === "replayed") {
    return { status: result.response.status, body: result.response.body };
  }
  if (result.kind === "conflict" || result.kind === "in-progress") {
    return { status: 409, body: { error: result.kind === "conflict"
      ? "Idempotency key conflicts with another request"
      : "A request with this key is still processing" } };
  }
  return submissionUnavailable();
}

async function runBuildIdempotently(
  validatedRequest: unknown,
  options: BuildRequestOptions,
  execute: () => Promise<RouteResult>
): Promise<RouteResult> {
  let store: IdempotencyStore;
  try { store = options.store ?? loadIdempotencyStore(process.env); }
  catch (err) { return submissionUnavailable(err); }
  const requestHash = hashValidatedRequest(validatedRequest);
  const keyDigest = hashValidatedRequest(options.idempotencyKey?.trim() || requestHash);
  let executedRouteResult: RouteResult | undefined;
  const result = await runNonTransactionIdempotently({
    store, key: `meridian:tx:${APP_NETWORK.network}:build:${keyDigest}`, validatedRequest,
    execute: async () => {
      const response = await execute();
      executedRouteResult = response;
      return { status: response.status, body: response.body };
    },
  });
  const routeResult = idempotencyResult(result);
  if (
    result.kind === "executed" &&
    executedRouteResult &&
    "error" in executedRouteResult
  ) {
    return { ...routeResult, error: executedRouteResult.error };
  }
  return routeResult;
}

export interface SubmitRequestOptions {
  /** Supplied by the API adapter once it forwards the Idempotency-Key header. */
  idempotencyKey?: string;
  /** Injection seam for deterministic tests and alternate API runtimes. */
  store?: IdempotencyStore;
}

class SubmissionGateError extends Error {
  constructor(readonly result: SubmissionClaimResult) {
    super("Idempotent submission did not acquire a send permit");
    this.name = "SubmissionGateError";
  }
}

function submissionUnavailable(err?: unknown): RouteResult {
  return {
    status: 503,
    body: { error: "Submission could not be safely confirmed. Retry with the same key." },
    ...(err !== undefined && { error: err }),
  };
}

function submissionGateResult(result: SubmissionClaimResult): RouteResult {
  switch (result.kind) {
    case "replayed":
      return { status: result.response.status, body: result.response.body };
    case "conflict":
      return { status: 409, body: { error: "Idempotency key conflicts with another request" } };
    case "in-progress":
      return { status: 409, body: { error: "A request with this key is still processing" } };
    case "outcome-unknown":
    case "unavailable":
      return submissionUnavailable();
    case "ready":
      return submissionUnavailable();
  }
}

function networkForSubmission(network: string): StellarNetwork | undefined {
  if (network === APP_NETWORK.network) return APP_NETWORK;
  if (network === "mainnet" || network === "testnet") {
    return STELLAR_NETWORKS[network];
  }
  return undefined;
}

async function reconcileExistingSubmission(
  store: IdempotencyStore,
  key: string,
  record: UnknownSubmissionRecord
): Promise<SubmissionClaimResult> {
  const network = networkForSubmission(record.network);
  if (!network) return { kind: "outcome-unknown", record };

  let observed: Awaited<ReturnType<typeof getTransactionForReconciliation>>;
  try {
    observed = await getTransactionForReconciliation(
      record.transactionHash,
      network
    );
  } catch {
    return unresolvedReconciliationResult(store, key);
  }

  const rpcResult = observed as unknown as {
    status?: unknown;
    txHash?: unknown;
  } | null;
  if (!rpcResult || typeof rpcResult !== "object") {
    return unresolvedReconciliationResult(store, key);
  }

  const status = rpcResult.status;
  if (status !== "SUCCESS" && status !== "FAILED" && status !== "NOT_FOUND") {
    return unresolvedReconciliationResult(store, key);
  }

  const transactionHash = rpcResult.txHash;
  if (
    typeof transactionHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(transactionHash) ||
    !/^[0-9a-f]{64}$/i.test(record.transactionHash) ||
    transactionHash.toLowerCase() !== record.transactionHash.toLowerCase()
  ) {
    return unresolvedReconciliationResult(store, key);
  }

  let observation: SubmissionObservation;

  if (status === "SUCCESS") {
    observation = {
      kind: "SUCCESS",
      transactionHash: record.transactionHash,
      response: { status: 200, body: { hash: record.transactionHash } },
    };
  } else if (status === "FAILED") {
    const failed = txErrorResult(
      new TransactionFailedError(record.transactionHash),
      "Failed to submit transaction"
    );
    observation = {
      kind: "FAILED",
      transactionHash: record.transactionHash,
      response: { status: failed.status, body: failed.body },
    };
  } else {
    observation = {
      kind: "NOT_FOUND",
      transactionHash: record.transactionHash,
      latestLedger: observed.latestLedger,
      latestLedgerCloseTime: String(observed.latestLedgerCloseTime),
      oldestLedger: observed.oldestLedger,
      expiredResponse: {
        status: 410,
        body: {
          error:
            "Transaction expired without being found in retained RPC history. Prepare and sign a new transaction.",
        },
      },
    };
  }

  const reconciled = await reconcileIdempotentSubmission({
    store,
    key,
    observation,
  });
  if (reconciled.kind === "completed") {
    return { kind: "replayed", response: reconciled.response };
  }
  if (reconciled.kind === "outcome-unknown") {
    return { kind: "outcome-unknown", record: reconciled.record };
  }
  return { kind: "unavailable" };
}

async function unresolvedReconciliationResult(
  store: IdempotencyStore,
  key: string
): Promise<SubmissionClaimResult> {
  const current = await reconcileIdempotentSubmission({
    store,
    key,
    observation: { kind: "RPC_TIMEOUT" },
  });
  if (current.kind === "completed") {
    return { kind: "replayed", response: current.response };
  }
  if (current.kind === "outcome-unknown") {
    return { kind: "outcome-unknown", record: current.record };
  }
  return { kind: "unavailable" };
}

function isValidSubmitRecord(value: unknown): value is IdempotencyRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestHash !== "string" ||
    !/^[\da-f]{64}$/i.test(record.requestHash) ||
    typeof record.ownerToken !== "string" ||
    record.ownerToken.length === 0
  ) return false;

  if (record.state === "processing") {
    return typeof record.createdAtMs === "number" &&
      Number.isFinite(record.createdAtMs) &&
      typeof record.updatedAtMs === "number" &&
      Number.isFinite(record.updatedAtMs);
  }
  if (record.state === "completed") {
    const response = record.response as Record<string, unknown> | undefined;
    return (record.resolution === "SUCCESS" || record.resolution === "FAILED" ||
      record.resolution === "EXPIRED") &&
      typeof record.completedAtMs === "number" &&
      Number.isFinite(record.completedAtMs) &&
      typeof response === "object" && response !== null &&
      typeof response.status === "number" &&
      Number.isInteger(response.status) && response.status >= 100 &&
      response.status <= 599 &&
      Object.prototype.hasOwnProperty.call(response, "body");
  }
  if (record.state === "outcome_unknown") {
    const validMaxTime = typeof record.maxTime === "string" &&
      /^\d+$/.test(record.maxTime) && BigInt(record.maxTime) > 0n;
    const validMaxLedger = typeof record.maxLedger === "number" &&
      Number.isSafeInteger(record.maxLedger) && record.maxLedger > 0;
    return /^[\da-f]{64}$/i.test(String(record.transactionHash)) &&
      typeof record.signedXdr === "string" && record.signedXdr.length > 0 &&
      (record.network === "mainnet" || record.network === "testnet" ||
        record.network === "futurenet") &&
      typeof record.sourceAccount === "string" && record.sourceAccount.length > 0 &&
      typeof record.sequence === "string" && /^\d+$/.test(record.sequence) &&
      (validMaxTime || validMaxLedger) &&
      (record.maxTime === null || validMaxTime) &&
      (record.maxLedger === null || validMaxLedger) &&
      (record.submissionStartLedger === null ||
        (typeof record.submissionStartLedger === "number" &&
          Number.isSafeInteger(record.submissionStartLedger) &&
          record.submissionStartLedger >= 0)) &&
      typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs) &&
      typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs);
  }
  return false;
}

async function preflightSubmission(
  store: IdempotencyStore,
  key: string,
  requestHash: string
): Promise<RouteResult | undefined> {
  let stored: StoredIdempotencyRecord | null;
  try {
    stored = await store.get(key);
  } catch (err) {
    return submissionUnavailable(err);
  }
  if (stored === null) return undefined;
  if (
    !stored || typeof stored !== "object" ||
    typeof stored.revision !== "string" || stored.revision.length === 0 ||
    !isValidSubmitRecord(stored.record)
  ) return submissionUnavailable();

  const record = stored.record;
  if (record.requestHash !== requestHash) {
    return submissionGateResult({ kind: "conflict" });
  }
  if (record.state === "completed") {
    return submissionGateResult({
      kind: "replayed",
      response: record.response,
    });
  }
  if (record.state === "processing") {
    return submissionGateResult({ kind: "in-progress" });
  }
  return submissionGateResult(
    await reconcileExistingSubmission(store, key, record)
  );
}

export async function handleSubmitRequest(
  body: unknown,
  options: SubmitRequestOptions = {}
): Promise<RouteResult> {
  const parsed = SubmitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: formatZodError(parsed.error) } };
  }

  const requestHash = hashValidatedRequest(parsed.data);
  const suppliedKey = options.idempotencyKey?.trim();
  const keyDigest = hashValidatedRequest(suppliedKey || requestHash);
  const key = `meridian:tx:${APP_NETWORK.network}:submit:${keyDigest}`;
  let store: IdempotencyStore;
  try {
    store = options.store ?? loadIdempotencyStore(process.env);
  } catch (err) {
    return submissionUnavailable(err);
  }

  const preflight = await preflightSubmission(store, key, requestHash);
  if (preflight) return preflight;

  let submissionOwner: string | undefined;
  try {
    const result = await submitTx(parsed.data.xdr, APP_NETWORK, {
      beforeSubmit: async (identity) => {
        const claim = await beginIdempotentSubmission({
          store,
          key,
          validatedRequest: parsed.data,
          submission: identity,
        });
        if (claim.kind === "outcome-unknown") {
          throw new SubmissionGateError(
            await reconcileExistingSubmission(store, key, claim.record)
          );
        }
        if (claim.kind !== "ready") throw new SubmissionGateError(claim);
        submissionOwner = claim.record.ownerToken;
      },
    });
    if (!submissionOwner) return submissionUnavailable();

    const responseBody = { hash: result.hash };
    const response: IdempotencyResponse = { status: 200, body: responseBody };
    const reconciled = await reconcileIdempotentSubmission({
      store,
      key,
      observation: {
        kind: "SUCCESS",
        transactionHash: result.hash,
        response,
      },
    });
    if (reconciled.kind !== "completed" || reconciled.resolution !== "SUCCESS") {
      return submissionUnavailable();
    }
    return { status: response.status, body: responseBody };
  } catch (err) {
    if (err instanceof SubmissionGateError) {
      return submissionGateResult(err.result);
    }
    if (submissionOwner) {
      if (err instanceof TransactionFailedError) {
        const failedResponse = txErrorResult(err, "Failed to submit transaction");
        const reconciled = await reconcileIdempotentSubmission({
          store,
          key,
          observation: {
            kind: "FAILED",
            transactionHash: err.transactionHash,
            response: { status: failedResponse.status, body: failedResponse.body },
          },
        });
        if (reconciled.kind === "completed" && reconciled.resolution === "FAILED") {
          return { ...failedResponse };
        }
      }
      // A rejection, TRY_AGAIN_LATER, timeout, Redis failure, or any other
      // post-claim error is not evidence that the transaction failed.
      return submissionUnavailable(err);
    }
    return txErrorResult(err, "Failed to submit transaction");
  }
}
