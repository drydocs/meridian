// Shared transaction-submission primitives for scheduled keepers (accrual,
// migration): building, signing, and sending a single contract invocation
// from the keeper's own key, with in-flight tracking so a confirmation
// timeout on retry never causes a duplicate on-chain call.

import {
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { withRaceTimeout } from "@meridian/shared";
import {
  describeSendError,
  simErrorMessage,
  simulateView,
  waitForTransaction,
} from "./tx";
import type { StellarNetwork } from "./types";
import { errorMessage } from "./keeper-retry";

// Transactions are built with this validity window (`setTimeout` below), so
// it is also the point past which a submitted transaction can never land.
// Exported because the submission-record TTL in keeper-state.ts is derived
// from it: a record that expired sooner would clear while its transaction
// could still be landing.
export const TX_VALIDITY_WINDOW_MS = 300_000;

// Starting classic inclusion fee for keeper-submitted transactions, in
// stroops. Deliberately well above the network's absolute floor (100
// stroops, `internal.ts`'s BASE_FEE, still fine for user-facing tx building
// where a wallet can react to a rejection): an unattended keeper has no
// human to bump a fee after the fact, so bidding at the literal minimum
// produces real `txInsufficientFee` rejections during ordinary fee-market
// congestion. Still economically negligible (0.001 XLM) for a bot with no
// other reason to save stroops.
export const KEEPER_BASE_FEE_STROOPS = 10_000;

// Ceiling on the escalated fee, in stroops (0.1 XLM). `maxAttempts` is only
// validated as a positive integer (parsePositiveInt, keeper-retry.ts) with
// no upper bound, so an operator raising it to ride out sustained
// congestion (e.g. to 20) would otherwise make the doubling schedule below
// bid billions of stroops with nothing to stop it. 0.1 XLM is already a
// very high inclusion fee for Stellar; real congestion is not expected to
// require bidding anywhere near this.
export const KEEPER_MAX_FEE_STROOPS = 1_000_000;

export interface FeeEscalationConfig {
  maxFee: number;
  multiplier: number;
}

export const DEFAULT_FEE_ESCALATION: FeeEscalationConfig = {
  maxFee: KEEPER_MAX_FEE_STROOPS,
  multiplier: 2,
};

// Doubles per retry attempt (attempt 0 -> 1x, 1 -> 2x, 2 -> 4x, ...), capped
// at config.maxFee, so a `txInsufficientFee` rejection (classified
// transient, see isTransientKeeperError below) has an actual chance of
// clearing on retry instead of failing identically every time with the
// same losing bid. `attempt` is 0-indexed so the first submission uses
// exactly `baseFee`, the first retry `baseFee * multiplier`, and so on.
// Exported for direct unit testing rather than exercising it only through
// the full build/sign/submit pipeline in submitKeeperOperation.
export function keeperFeeForAttempt(
  attempt: number,
  baseFee: number,
  config: Partial<FeeEscalationConfig> = {}
): number {
  const { maxFee, multiplier } = { ...DEFAULT_FEE_ESCALATION, ...config };
  const fee = baseFee * multiplier ** attempt;
  return Math.min(fee, maxFee);
}

// A real rpc.Server satisfies this directly (no cast needed); a narrower
// Pick instead of the hand-written interface this used to be means the
// signatures can never silently drift from the real SDK's.
export type KeeperRpcServer = Pick<
  rpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction"
>;

// Thrown when a transaction was successfully sent (we have its hash) but
// confirmation couldn't be observed before the configured timeout elapsed.
// Carries the hash so a retry can check whether it actually landed before
// ever submitting a second, duplicate call, distinct from a failure before
// sendTransaction, where nothing was submitted and a fresh attempt is
// always safe.
export class SubmissionInFlightError extends Error {
  constructor(
    readonly sentHash: string,
    cause: unknown
  ) {
    super(errorMessage(cause));
    this.name = "SubmissionInFlightError";
  }
}

// Unlike errorMessage() (first line only, for concise logging/display), this
// keeps the full message for transient-error classification: a status code
// or keyword on a later line (e.g. a wrapped fetch error whose first line is
// generic) would otherwise be invisible to callers classifying an error.
export function rawErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// waitForTransaction (tx.ts) throws two meaningfully different errors:
// "Transaction X failed on-chain" (the network confirmed it, a permanent,
// known outcome) vs. "Timed out waiting for transaction X to confirm" (the
// client gave up, the real outcome is still unknown). Only the second is
// worth treating as transient/retryable-by-rechecking; the first means
// resubmitting would just fail the same way again (or waste a fee finding
// out), and should be reported as a definitive submit failure instead.
export function isDefinitiveOnChainFailure(err: unknown): boolean {
  return rawErrorText(err).includes("failed on-chain");
}

// Thrown when a prior attempt's transaction was confirmed as genuinely
// failed on-chain (not merely unconfirmed/timed out). Always non-transient:
// retrying would resubmit a fresh transaction that has no reason to succeed
// where the first one didn't.
export class SubmissionFailedError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "SubmissionFailedError";
  }
}

// HTTP status codes are matched with word boundaries so a permanent error
// whose message happens to contain those digits elsewhere (e.g. an amount or
// ledger number) isn't misclassified as transient.
const TRANSIENT_STATUS_CODE = /\b(429|500|502|503|504)\b/;

// Shared transient-error classification for keeper submission/discovery
// retries. A confirmed on-chain failure is explicitly never transient,
// regardless of what its message text happens to contain; an in-flight
// submission always is, since its real outcome just isn't known yet.
export function isTransientKeeperError(err: unknown): boolean {
  if (err instanceof SubmissionFailedError) return false;
  if (err instanceof SubmissionInFlightError) return true;
  const message = rawErrorText(err).toLowerCase();
  return (
    message.includes("try again") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    // The network rejected the bid before the transaction ever entered the
    // mempool, not a definitive on-chain outcome. Retrying with a higher fee
    // (see submitKeeperOperation's per-attempt fee escalation) is the
    // correct response, unlike most other rejections here.
    message.includes("txinsufficientfee") ||
    TRANSIENT_STATUS_CODE.test(message)
  );
}

// simulateView returns unknown (a decoded ScVal), which can be null or a
// non-string value depending on how the contract's return type decodes.
// Address/Symbol-returning view methods are documented to decode to a
// string; anything else means the on-chain return type didn't match, and
// using it as a contract ID would otherwise surface as a confusing
// low-level `Contract` constructor error instead of this clear one.
export function expectString(
  value: unknown,
  method: string,
  contractId: string
): string {
  if (typeof value !== "string") {
    throw new Error(
      `${method}() on ${contractId} did not return a string (got ${typeof value})`
    );
  }
  return value;
}

// Thrown by the stale-adapter guard below: the caller's view of which
// adapter a vault is using is out of date, something else already changed
// it. Shared by both keepers: the migration keeper uses it to avoid
// migrating off an adapter the vault no longer has, and the accrual keeper
// to avoid accruing on an adapter the vault has already migrated away from
// (a silently ineffective call, since a detached adapter is still a valid
// contract). Both treat it as a benign, expected race, a skip rather than a
// failure.
//
// Detected downstream by message text, not `instanceof`: withKeeperRetry
// wraps whatever it catches in a KeeperRetryError (keeper-retry.ts), which
// preserves the message but not the original error's type. Same approach
// isDefinitiveOnChainFailure already uses for the equivalent problem.
export const STALE_ADAPTER_MESSAGE = "Vault's adapter changed since discovery";

export class StaleAdapterError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `${STALE_ADAPTER_MESSAGE} (expected ${expected}, now ${actual}); skipping to avoid a stale call`
    );
    this.name = "StaleAdapterError";
  }
}

export function isStaleAdapterError(err: unknown): boolean {
  return errorMessage(err).includes(STALE_ADAPTER_MESSAGE);
}

// migrate_adapter's on-chain MigrationCooldownNotMet rejection (#20 in
// packages/contracts/vault/src/errors.rs), surfaced from simulation as the
// raw contract error text below, not a custom Error subclass: unlike
// StaleAdapterError above, nothing in this codebase constructs this
// rejection, it comes straight from the contract, so there's no call site
// to throw a typed error from in the first place. Matched by message text
// for the same reason isStaleAdapterError is: withKeeperRetry's wrapping
// loses the original error's type by the time this runs.
//
// A benign, expected outcome, not a failure: #557 lengthened
// MIN_LEDGER_GAP from ~1 minute to ~1 day specifically so an observer has
// a full day to notice and react to a suspicious begin_migration before
// migrate_adapter can execute. Every hourly run during that window is
// expected to hit this rejection until the cooldown elapses; treating it
// as a failure would page on end-to-end intended behavior for roughly 24
// consecutive runs per migration (#725).
export const MIGRATION_COOLDOWN_ERROR_TEXT = "Error(Contract, #20)";

// Same sentence as VAULT_CONTRACT_ERROR_MESSAGES[20]. Kept here so this
// check still works after simErrorMessage rewrites the host error, without
// importing that map through the tx module the keeper tests mock.
const MIGRATION_COOLDOWN_FRIENDLY_TEXT =
  "The migration cooldown has not elapsed yet.";

export function isMigrationCooldownError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes(MIGRATION_COOLDOWN_ERROR_TEXT) ||
    message.includes(MIGRATION_COOLDOWN_FRIENDLY_TEXT)
  );
}

/**
 * Re-reads the vault's live `get_adapter()` and throws StaleAdapterError if
 * it no longer matches what this run discovered. A cheap, best-effort guard
 * that narrows, but cannot close, the window between deciding to act on an
 * adapter and the transaction landing: it catches the common case of "a
 * prior run already changed this vault's adapter" for one simulate call.
 */
export async function assertAdapterUnchanged(
  server: KeeperRpcServer,
  vaultContractId: string,
  networkPassphrase: string,
  expectedAdapterId: string
): Promise<void> {
  const liveAdapterId = expectString(
    await simulateView(
      server as never,
      vaultContractId,
      networkPassphrase,
      "get_adapter"
    ),
    "get_adapter",
    vaultContractId
  );
  if (liveAdapterId !== expectedAdapterId) {
    throw new StaleAdapterError(expectedAdapterId, liveAdapterId);
  }
}

// Lifecycle hooks around the two moments that matter for cross-invocation
// dedup:
//
// `onSigned` fires as soon as a transaction is signed and its hash is known,
// *before* `sendTransaction`. Recording after the send returns would miss
// the cases that matter most: a send that times out, or comes back
// TRY_AGAIN_LATER, may already have put the transaction in the mempool with
// no record of it anywhere.
//
// `onResolved` fires once that hash's fate is known: confirmed, definitively
// failed on-chain, or rejected outright at submission.
//
// Both are invoked defensively: a throwing hook must never surface as a
// submission error, since the retry loop would answer that by broadcasting a
// second transaction, exactly the duplicate the hooks exist to prevent.
// Implementations are expected to log their own failures (see
// keeper-state.ts).
export interface KeeperSubmissionHooks {
  onSigned?: (hash: string) => Promise<void>;
  onResolved?: (hash: string) => Promise<void>;
}

async function runHook(
  hook: ((hash: string) => Promise<void>) | undefined,
  hash: string
): Promise<void> {
  if (!hook) return;
  try {
    await hook(hash);
  } catch {
    // Deliberately swallowed, see KeeperSubmissionHooks above.
  }
}

export interface KeeperTxConfig {
  network: StellarNetwork;
  secretKey: string;
  rpcTimeoutMs: number;
  confirmationTimeoutMs: number;
}

export interface KeeperTransactionRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface KeeperTransactionFeePolicy extends FeeEscalationConfig {
  baseFee?: number;
}

export interface KeeperTransactionClientConfig {
  signer: Keypair;
  server: KeeperRpcServer;
  rpcTimeoutMs: number;
  confirmationTimeoutMs: number;
  retryPolicy: KeeperTransactionRetryPolicy;
  feeEscalation?: KeeperTransactionFeePolicy;
  deadlineAt: number;
}

export type KeeperTransactionResult =
  | { status: "landed"; hash: string; ledger: number; attempts: number }
  | { status: "duplicate"; hash: string; ledger: number; attempts: number }
  | { status: "retryable"; error: unknown; attempts: number }
  | { status: "terminal"; error: unknown; attempts: number };

export interface KeeperTransactionSubmitOptions {
  priorHash?: string;
  hooks?: KeeperSubmissionHooks;
  initialAttempt?: number;
}

const defaultRetrySleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isDuplicateSubmissionError(err: unknown): boolean {
  return /duplicate|already (?:known|submitted|in the ledger)/i.test(
    rawErrorText(err)
  );
}

class KeeperTransactionDeadlineError extends Error {
  constructor() {
    super("Keeper transaction deadline exhausted");
    this.name = "KeeperTransactionDeadlineError";
  }
}

/**
 * Submits transactions built from fresh account state, applying bounded fee
 * escalation and retrying only while the run deadline permits.
 */
export class KeeperTransactionClient {
  constructor(private readonly config: KeeperTransactionClientConfig) {
    const { retryPolicy, feeEscalation, deadlineAt } = config;
    if (
      !Number.isInteger(retryPolicy.maxAttempts) ||
      retryPolicy.maxAttempts < 1
    ) {
      throw new Error("retryPolicy.maxAttempts must be a positive integer");
    }
    if (
      !Number.isFinite(retryPolicy.baseDelayMs) ||
      retryPolicy.baseDelayMs < 0
    ) {
      throw new Error("retryPolicy.baseDelayMs must be a non-negative number");
    }
    if (!Number.isFinite(deadlineAt)) {
      throw new Error("deadlineAt must be a finite timestamp");
    }
    if (
      !Number.isFinite(config.rpcTimeoutMs) ||
      config.rpcTimeoutMs <= 0 ||
      !Number.isFinite(config.confirmationTimeoutMs) ||
      config.confirmationTimeoutMs <= 0
    ) {
      throw new Error("RPC and confirmation timeouts must be positive numbers");
    }
    if (
      feeEscalation &&
      (!Number.isInteger(feeEscalation.maxFee) ||
        feeEscalation.maxFee <= 0 ||
        !Number.isFinite(feeEscalation.multiplier) ||
        feeEscalation.multiplier < 1 ||
        (feeEscalation.baseFee !== undefined &&
          (!Number.isInteger(feeEscalation.baseFee) ||
            feeEscalation.baseFee <= 0)))
    ) {
      throw new Error(
        "feeEscalation must contain positive fees and a multiplier >= 1"
      );
    }
  }

  async submit(
    buildTransaction: (fee: number, attempt: number) => Promise<Transaction>,
    options: KeeperTransactionSubmitOptions = {}
  ): Promise<KeeperTransactionResult> {
    if (
      options.initialAttempt !== undefined &&
      (!Number.isInteger(options.initialAttempt) || options.initialAttempt < 0)
    ) {
      throw new Error("initialAttempt must be a non-negative integer");
    }
    const { retryPolicy, feeEscalation } = this.config;
    const isRetryable = (error: unknown) =>
      error instanceof KeeperTransactionDeadlineError ||
      error instanceof SubmissionInFlightError ||
      (retryPolicy.isRetryable ?? isTransientKeeperError)(error);
    const sleep = retryPolicy.sleep ?? defaultRetrySleep;
    let priorHash = options.priorHash;
    let wasDuplicate = false;
    let attempts = 0;
    let lastError: unknown;

    while (attempts < retryPolicy.maxAttempts) {
      if (Date.now() >= this.config.deadlineAt) {
        return {
          status:
            lastError && !isRetryable(lastError) ? "terminal" : "retryable",
          error:
            lastError ?? new Error("Keeper transaction deadline exhausted"),
          attempts,
        };
      }

      attempts += 1;
      try {
        if (priorHash) {
          try {
            const confirmed = await waitForTransaction(
              this.config.server,
              priorHash,
              {
                timeoutMs: this.remainingTimeout(
                  this.config.confirmationTimeoutMs
                ),
              }
            );
            await runHook(options.hooks?.onResolved, priorHash);
            return {
              status: wasDuplicate ? "duplicate" : "landed",
              hash: priorHash,
              ledger: confirmed.ledger,
              attempts,
            };
          } catch (err) {
            if (isDefinitiveOnChainFailure(err)) {
              await runHook(options.hooks?.onResolved, priorHash);
              throw new SubmissionFailedError(err);
            }
            throw err;
          }
        }

        const attempt = (options.initialAttempt ?? 0) + attempts - 1;
        const fee = Math.ceil(
          keeperFeeForAttempt(
            attempt,
            feeEscalation?.baseFee ?? KEEPER_BASE_FEE_STROOPS,
            feeEscalation
          )
        );
        const transaction = await withRaceTimeout(
          () => buildTransaction(fee, attempt),
          this.remainingTimeout(this.config.rpcTimeoutMs),
          "Soroban RPC"
        );
        const simulation = await withRaceTimeout(
          () => this.config.server.simulateTransaction(transaction),
          this.remainingTimeout(this.config.rpcTimeoutMs),
          "Soroban RPC"
        );
        if (rpc.Api.isSimulationError(simulation)) {
          throw new Error(
            `Simulation failed: ${simErrorMessage(simulation.error)}`
          );
        }
        if (!rpc.Api.isSimulationSuccess(simulation)) {
          throw new Error("Simulation did not return a successful result");
        }

        const prepared = rpc
          .assembleTransaction(transaction, simulation)
          .build();
        prepared.sign(this.config.signer);
        const hash = prepared.hash().toString("hex");
        await runHook(options.hooks?.onSigned, hash);

        let sent: Awaited<ReturnType<KeeperRpcServer["sendTransaction"]>>;
        try {
          sent = await withRaceTimeout(
            () => this.config.server.sendTransaction(prepared),
            this.remainingTimeout(this.config.rpcTimeoutMs),
            "Soroban RPC"
          );
        } catch (err) {
          throw new SubmissionInFlightError(hash, err);
        }

        if (sent.status === "ERROR") {
          const sendError = new Error(
            `Transaction rejected at submission: ${describeSendError(sent)}`
          );
          if (isDuplicateSubmissionError(sendError)) {
            priorHash = hash;
            wasDuplicate = true;
            throw new SubmissionInFlightError(hash, sendError);
          }
          await runHook(options.hooks?.onResolved, hash);
          throw sendError;
        }
        if (sent.status === "TRY_AGAIN_LATER") {
          throw new SubmissionInFlightError(
            hash,
            new Error(
              "Transaction could not be submitted yet (try again later)"
            )
          );
        }
        if (sent.status === "DUPLICATE") {
          wasDuplicate = true;
        }

        try {
          const confirmed = await waitForTransaction(
            this.config.server,
            sent.hash,
            {
              timeoutMs: this.remainingTimeout(
                this.config.confirmationTimeoutMs
              ),
            }
          );
          await runHook(options.hooks?.onResolved, sent.hash);
          return {
            status: wasDuplicate ? "duplicate" : "landed",
            hash: sent.hash,
            ledger: confirmed.ledger,
            attempts,
          };
        } catch (err) {
          if (isDefinitiveOnChainFailure(err)) {
            await runHook(options.hooks?.onResolved, sent.hash);
            throw new SubmissionFailedError(err);
          }
          throw new SubmissionInFlightError(sent.hash, err);
        }
      } catch (err) {
        lastError = err;
        if (err instanceof SubmissionInFlightError) {
          priorHash = err.sentHash;
        } else if (!isRetryable(err)) {
          return { status: "terminal", error: err, attempts };
        }

        if (attempts >= retryPolicy.maxAttempts) break;
        const delayMs = retryPolicy.baseDelayMs * 2 ** (attempts - 1);
        if (Date.now() + delayMs >= this.config.deadlineAt) break;
        await sleep(delayMs);
      }
    }

    return {
      status: lastError && !isRetryable(lastError) ? "terminal" : "retryable",
      error: lastError ?? new Error("Keeper transaction deadline exhausted"),
      attempts,
    };
  }

  private remainingTimeout(timeoutMs: number): number {
    const remaining = this.config.deadlineAt - Date.now();
    if (remaining <= 0) throw new KeeperTransactionDeadlineError();
    return Math.max(1, Math.min(timeoutMs, remaining));
  }
}

// Builds, signs, and submits a single contract invocation from the keeper's
// own key. When `priorHash` is set (an earlier attempt already sent a
// transaction), this checks that transaction's real status first instead of
// building a new one: it never falls through to building a fresh
// transaction on this call, only re-throws to keep tracking the *same* hash,
// until the prior transaction's fate is actually known (confirmed success or
// confirmed on-chain failure). Callers must persist `priorHash` across their
// own retry attempts (see accrual-keeper.ts and migration-keeper.ts), and
// persist it across invocations through `hooks` (see keeper-state.ts).
// `attempt` (0-indexed, matching withKeeperRetry's callback, see
// keeperFeeForAttempt above) sets the classic inclusion fee for a
// freshly-built transaction, escalating on each retry so a
// `txInsufficientFee` rejection has a real chance of clearing next time;
// irrelevant when `priorHash` is set, since that path only rechecks an
// already-sent transaction and never rebuilds one.
export async function submitKeeperOperation(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  config: KeeperTxConfig,
  server: KeeperRpcServer,
  priorHash?: string,
  hooks?: KeeperSubmissionHooks,
  attempt = 0
): Promise<{ hash: string; ledger: number }> {
  if (priorHash) {
    try {
      const confirmed = await waitForTransaction(server, priorHash, {
        timeoutMs: config.confirmationTimeoutMs,
      });
      await runHook(hooks?.onResolved, priorHash);
      return { hash: priorHash, ledger: confirmed.ledger };
    } catch (err) {
      if (isDefinitiveOnChainFailure(err)) {
        await runHook(hooks?.onResolved, priorHash);
        throw new SubmissionFailedError(err);
      }
      throw new SubmissionInFlightError(priorHash, err);
    }
  }

  const keypair = Keypair.fromSecret(config.secretKey);
  // The keeper orchestration retains retry timing, logging, and attempt
  // accounting; this adapter delegates each fresh submission attempt to the
  // reusable client without nesting another retry loop.
  const client = new KeeperTransactionClient({
    signer: keypair,
    server,
    rpcTimeoutMs: config.rpcTimeoutMs,
    confirmationTimeoutMs: config.confirmationTimeoutMs,
    retryPolicy: {
      maxAttempts: 1,
      baseDelayMs: 0,
    },
    deadlineAt: Number.MAX_SAFE_INTEGER,
  });
  const result = await client.submit(
    async (fee) => {
      const source = await withRaceTimeout(
        () => server.getAccount(keypair.publicKey()),
        config.rpcTimeoutMs,
        "Soroban RPC"
      );
      return new TransactionBuilder(source, {
        fee: String(fee),
        networkPassphrase: config.network.passphrase,
      })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(TX_VALIDITY_WINDOW_MS / 1000)
        .build();
    },
    {
      ...(hooks !== undefined && { hooks }),
      initialAttempt: attempt,
    }
  );
  if (result.status === "landed" || result.status === "duplicate") {
    return { hash: result.hash, ledger: result.ledger };
  }
  throw result.error;
}
