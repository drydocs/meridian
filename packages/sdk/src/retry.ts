import { classifyError, type MeridianError } from "./errors.js";

/**
 * Opt-in retry policy. Retries are off unless a policy is configured, and
 * even then only read-only calls retry unless `retryTxBuilders` is set.
 */
export interface RetryPolicy {
  /** Total attempts including the first. Values below 1 are treated as 1. */
  maxAttempts: number;
  /** Delay before the first retry; doubles each retry. Default 200ms. */
  baseDelayMs?: number;
  /** Upper bound for a single delay. Default 5000ms. */
  maxDelayMs?: number;
  /** Add up to 25% random jitter to each delay. Default true. */
  jitter?: boolean;
  /** Decides whether to retry. Defaults to `error.retryable`. */
  shouldRetry?: (error: MeridianError, attempt: number) => boolean;
  /**
   * Also retry methods that build unsigned transactions (`deposit`,
   * `withdraw`, `setPaused`, ...). Default false.
   */
  retryTxBuilders?: boolean;
}

export const DEFAULT_BASE_DELAY_MS = 200;
export const DEFAULT_MAX_DELAY_MS = 5_000;

export function retryDelayMs(
  policy: RetryPolicy,
  retryNumber: number,
  random: () => number = Math.random
): number {
  const base = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const exp = Math.min(max, base * 2 ** (retryNumber - 1));
  const jitter = (policy.jitter ?? true) ? exp * 0.25 * random() : 0;
  return Math.min(max, Math.round(exp + jitter));
}

export interface RetryHooks {
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: MeridianError;
  }) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying per `policy`. Errors are classified; the final error is
 * always a `MeridianError`. `fn` receives the 1-based attempt number.
 * Exported so callers can retry their own signing/submission steps explicitly.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy | undefined,
  hooks: RetryHooks = {}
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(policy?.maxAttempts ?? 1));
  const sleep = hooks.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const error = classifyError(raw);
      const retry =
        policy !== undefined &&
        attempt < maxAttempts &&
        (policy.shouldRetry
          ? policy.shouldRetry(error, attempt)
          : error.retryable);
      if (!retry) throw error;
      const delayMs = retryDelayMs(policy, attempt);
      hooks.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
