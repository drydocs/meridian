// Shared retry/logging primitives for scheduled keepers (accrual, migration).
// Kept generic: transient-error classification is protocol/keeper-specific
// and is passed in by the caller rather than hardcoded here.

import { sanitizeTxError, withRetry } from "@meridian/shared";

export interface KeeperLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const consoleLogger: KeeperLogger = {
  info(message, context) {
    console.info(message, context ?? {});
  },
  warn(message, context) {
    console.warn(message, context ?? {});
  },
  error(message, context) {
    console.error(message, context ?? {});
  },
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message.split("\n")[0]?.trim() || err.message;
  return String(err);
}

// For KeeperFailure.error specifically, not general logging: this value
// flows straight into /api/v1/keepers/{accrue,rebalance}'s JSON response,
// unlike errorMessage() above (used for internal log context, which stays
// verbose since it never leaves the server). Reuses the same RPC-URL/
// contract-address redaction the rest of the API already applies at its
// response boundaries (packages/api-core/src/tx.ts), so keeper failures
// aren't the one response shape in the codebase that skips it.
export function redactedErrorMessage(err: unknown): string {
  return sanitizeTxError(err, "Keeper operation failed");
}

function parseIntEnv(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  minimumLabel: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a ${minimumLabel} integer`);
  }
  return parsed;
}

export function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  return parseIntEnv(value, fallback, name, 1, "positive");
}

export function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  return parseIntEnv(value, fallback, name, 0, "non-negative");
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  deadlineAt?: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  deadlineAt?: number;
  logger?: KeeperLogger;
  context?: Record<string, unknown>;
  sleepFn?: (ms: number) => Promise<void>;
  isTransient?: (err: unknown) => boolean;
  logPrefix?: string;
}

export const DEFAULT_RETRY_OPTIONS: Required<
  Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "sleepFn" | "isTransient">
> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  sleepFn: sleep,
  isTransient: () => true,
};

// Common shape for a failed keeper operation, shared across every scheduled
// keeper (accrual, migration) so callers and API responses have one
// consistent structure to report against.
export interface KeeperFailure {
  vaultId?: string;
  vaultContractId?: string;
  adapterId?: string;
  protocol?: string;
  // "evaluate" is migration-keeper-specific (deciding whether a discovered
  // vault should migrate, distinct from finding it in the first place); the
  // accrual keeper only ever reports "discover" or "submit".
  stage: "discover" | "evaluate" | "submit";
  attempts: number;
  transient: boolean;
  error: string;
}

export class KeeperError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "KeeperError";
    this.cause = cause;
  }
}

export class KeeperRetryError extends KeeperError {
  readonly attempts: number;
  readonly transient: boolean;

  constructor(err: unknown, attempts: number, transient: boolean) {
    super(errorMessage(err), err);
    this.name = "KeeperRetryError";
    this.attempts = attempts;
    this.transient = transient;
  }
}

// A KeeperRetryError already carries the real attempt count and transience
// from the retry loop; anything else means the retry loop was never
// reached (e.g. a synchronous failure before the first attempt), which
// counts as a single attempt classified by the caller's own predicate.
export function retryOutcome(
  err: unknown,
  isTransient: (err: unknown) => boolean
): { attempts: number; transient: boolean } {
  if (err instanceof KeeperRetryError) {
    return { attempts: err.attempts, transient: err.transient };
  }
  return { attempts: 1, transient: isTransient(err) };
}

// Retries `fn` up to options.maxAttempts times with exponential backoff,
// classifying each failure via options.isTransient (default: all errors
// transient). A non-transient failure stops retrying immediately. When
// options.deadlineAt is set, a retry that would sleep past the deadline
// stops instead of sleeping into a doomed attempt, so a keeper bounded by
// a hard execution ceiling (e.g. Vercel's maxDuration) can return a clean
// partial result instead of being killed mid-retry.
//
// Attempts are 0-indexed: the first call to `fn` receives attempt=0, the
// first retry receives attempt=1, and so on. This matches the indexing
// convention used by keeperFeeForAttempt so callers can forward the
// attempt number straight into fee escalation without an off-by-one
// adjustment.
//
// A thin, keeper-specific wrapper over the shared withRetry (@meridian/shared):
// the core retry/backoff loop lives in one place, this only adds what's
// keeper-specific on top (structured KeeperLogger logging, the deadline
// check, attempt-count tracking, and wrapping the final failure in a
// KeeperRetryError so retryOutcome() can recover it downstream).
export async function withKeeperRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<{ value: T; attempts: number }> {
  const {
    maxAttempts,
    baseDelayMs,
    deadlineAt,
    logger = consoleLogger,
    context = {},
    sleepFn,
    isTransient,
    logPrefix,
  } = { ...DEFAULT_RETRY_OPTIONS, ...options };

  const actualSleepFn = sleepFn ?? DEFAULT_RETRY_OPTIONS.sleepFn;
  const actualIsTransient = isTransient ?? DEFAULT_RETRY_OPTIONS.isTransient;
  const prefix = logPrefix ? `[${logPrefix}] ` : "";

  let attempts = 0;
  let lastClassifiedErr: unknown;
  let lastClassifiedTransient = false;

  const shouldRetry = (err: unknown, attempt: number): boolean => {
    lastClassifiedErr = err;
    lastClassifiedTransient = actualIsTransient(err);
    if (!lastClassifiedTransient) return false;
    if (deadlineAt !== undefined) {
      const delayMs = baseDelayMs * 2 ** attempt;
      if (Date.now() + delayMs >= deadlineAt) {
        logger.warn(`${prefix}stopping retries; run deadline approaching`, {
          ...context,
          attempt: attempt + 1,
          delayMs,
        });
        return false;
      }
    }
    return true;
  };

  try {
    const value = await withRetry(
      async (attempt: number) => {
        attempts = attempt + 1;
        return fn(attempt);
      },
      maxAttempts,
      baseDelayMs,
      shouldRetry,
      {
        sleepFn: actualSleepFn,
        onRetry: (attempt: number, delayMs: number, err: unknown) => {
          logger.warn(`${prefix}transient failure; retrying`, {
            ...context,
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            delayMs,
            error: errorMessage(err),
          });
        },
      }
    );
    return { value, attempts };
  } catch (err) {
    const transient =
      err === lastClassifiedErr
        ? lastClassifiedTransient
        : actualIsTransient(err);
    throw new KeeperRetryError(err, attempts || 1, transient);
  }
}
