import { isValidStellarAddress } from "@meridian/shared";

/**
 * Route classes that get their own rate-limit budget. Every surface (the
 * Vercel handlers and the local Fastify server) resolves a request to one of
 * these instead of sharing a single IP-only bucket, so transaction traffic
 * cannot exhaust the read budget and a wallet that rotates IPs is still
 * counted against its own transaction budget.
 */
export type RateLimitPolicyName =
  "read" | "admin" | "txBuild" | "txSubmit" | "keeper" | "keeperHealth";

export interface RateLimitPolicy {
  /** Requests allowed per window, per key. */
  limit: number;
  windowMs: number;
  /**
   * Whether the wallet address is counted alongside the client IP. Both keys
   * are enforced, so rotating IPs does not reset a wallet's budget and
   * rotating wallets does not reset an IP's budget.
   */
  keyedByWallet: boolean;
  /**
   * Whether a missing distributed store is a hard error. Fund-moving and
   * keeper routes must not fall back to per-instance memory on a deployment.
   */
  failClosed: boolean;
}

export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Baseline budgets. Read traffic keeps the historical 100/min so existing
 * clients see no change; everything that builds or submits a transaction is
 * stricter, and submit is the strictest because it is the only route that
 * spends real fees and mutates on-chain state.
 */
export const RATE_LIMIT_POLICIES: Readonly<
  Record<RateLimitPolicyName, RateLimitPolicy>
> = {
  read: {
    limit: 100,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyedByWallet: false,
    failClosed: false,
  },
  admin: {
    limit: 60,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyedByWallet: false,
    failClosed: false,
  },
  txBuild: {
    limit: 30,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyedByWallet: true,
    failClosed: true,
  },
  txSubmit: {
    limit: 10,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyedByWallet: true,
    failClosed: true,
  },
  keeper: {
    limit: 60,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyedByWallet: false,
    failClosed: true,
  },
  // The keeper health probe is read-only and public, so it stays on the
  // read-style fallback while still not sharing the read budget.
  keeperHealth: {
    limit: 100,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyedByWallet: false,
    failClosed: false,
  },
};

/** `txSubmit` → `RATE_LIMIT_TX_SUBMIT_MAX`. */
function envNameFor(
  policy: RateLimitPolicyName,
  suffix: "MAX" | "WINDOW_MS"
): string {
  const snake = policy.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  return `RATE_LIMIT_${snake}_${suffix}`;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The enforced policy for a route class: the baseline above, overridden by
 * `RATE_LIMIT_<POLICY>_MAX` / `RATE_LIMIT_<POLICY>_WINDOW_MS` when those are
 * set to a positive integer. Invalid values are ignored rather than throwing,
 * so a typo degrades to the documented default instead of taking the API down.
 */
export function resolveRateLimitPolicy(
  name: RateLimitPolicyName,
  env: NodeJS.ProcessEnv = process.env
): RateLimitPolicy {
  const base = RATE_LIMIT_POLICIES[name];
  return {
    ...base,
    limit: positiveInt(env[envNameFor(name, "MAX")]) ?? base.limit,
    windowMs: positiveInt(env[envNameFor(name, "WINDOW_MS")]) ?? base.windowMs,
  };
}

/** Result of one rate-limit check, in the shape both surfaces report. */
export interface RateLimitOutcome {
  policy: RateLimitPolicyName;
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
  windowMs: number;
}

/**
 * Standard `RateLimit-*` headers describing the enforced policy, plus
 * `Retry-After` on a blocked request. Both surfaces emit these so a client
 * cannot tell which implementation answered it.
 */
export function buildRateLimitHeaders(
  outcome: RateLimitOutcome
): Record<string, string> {
  const resetSeconds = Math.max(1, Math.ceil(outcome.resetMs / 1000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(outcome.limit),
    "RateLimit-Remaining": String(Math.max(0, outcome.remaining)),
    "RateLimit-Reset": String(resetSeconds),
    "RateLimit-Policy": `${outcome.limit};w=${Math.max(
      1,
      Math.ceil(outcome.windowMs / 1000)
    )}`,
  };
  if (!outcome.allowed) headers["Retry-After"] = String(resetSeconds);
  return headers;
}

/** Body sent with the 429, carrying the same wait as `Retry-After`. */
export function rateLimitBlockedBody(outcome: RateLimitOutcome): {
  error: string;
  code: "RATE_LIMITED";
  retryAfter: number;
} {
  const retryAfter = Math.max(1, Math.ceil(outcome.resetMs / 1000));
  return {
    error: `Too many requests. Try again in ${retryAfter} second${
      retryAfter === 1 ? "" : "s"
    }.`,
    code: "RATE_LIMITED",
    retryAfter,
  };
}

/** Key for the per-IP bucket of a policy. */
export function rateLimitIpKey(
  policy: RateLimitPolicyName,
  ip: string
): string {
  return `${policy}:ip:${ip}`;
}

/** Key for the per-wallet bucket of a policy. */
export function rateLimitWalletKey(
  policy: RateLimitPolicyName,
  wallet: string
): string {
  return `${policy}:wallet:${wallet}`;
}

/**
 * Merges the IP and wallet checks for one request into a single outcome: the
 * request passes only when both buckets pass, and the reported remaining and
 * reset come from whichever bucket is closer to its limit.
 */
export function combineRateLimitOutcomes(
  a: RateLimitOutcome,
  b: RateLimitOutcome
): RateLimitOutcome {
  const tighter = a.remaining <= b.remaining ? a : b;
  const resetMs = Math.max(a.resetMs, b.resetMs);
  return {
    ...tighter,
    allowed: a.allowed && b.allowed,
    resetMs,
    remaining: Math.min(a.remaining, b.remaining),
  };
}

/**
 * The wallet a transaction request is about, when the body carries one.
 * Submit requests identify their wallet through the XDR source account
 * instead, so that route supplies it separately.
 */
export function walletAddressFromBody(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const candidate = (body as { walletAddress?: unknown }).walletAddress;
  return typeof candidate === "string" && isValidStellarAddress(candidate)
    ? candidate
    : undefined;
}
