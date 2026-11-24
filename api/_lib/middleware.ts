import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import {
  CONFIG_CACHE_CONTROL,
  HISTORY_CACHE_CONTROL,
  InMemoryRateLimitStore,
  MAINNET_VAULT_CACHE_CONTROL,
  RedisRateLimitStore,
  TESTNET_VAULT_CACHE_CONTROL,
  enforceRateLimit,
  resolveRateLimitPolicy,
  verifiedWalletFromRequest,
  vaultReadCacheControl,
  type RateLimitRoute,
  type RateLimitStore,
} from "@meridian/api-core";
import { Redis } from "@upstash/redis";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN;

// Vercel's Upstash integration provisions credentials under either store-prefixed or standard names
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ??
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ??
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

export const UPSTASH_CONFIGURED =
  Boolean(UPSTASH_URL) && Boolean(UPSTASH_TOKEN);

/**
 * Checks if production distributed Redis rate-limiting credentials are configured.
 */
export function isDistributedRateLimitingConfigured(): boolean {
  return UPSTASH_CONFIGURED;
}

const redis = UPSTASH_CONFIGURED
  ? new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! })
  : null;

// The Upstash REST client exposes the same INCR/PEXPIRE/PTTL commands as
// ioredis, so both deployments run the one fixed-window store in api-core
// instead of Upstash's separate sliding-window implementation.
const distributedStore: RateLimitStore | null = redis
  ? new RedisRateLimitStore(redis)
  : null;

const memoryStore = new InMemoryRateLimitStore();

/** Clears all in-memory rate-limit buckets. Exposed for tests only. */
export function resetRateLimitForTesting(): void {
  memoryStore.reset();
}

/**
 * Sets baseline security headers common to every API response. Every
 * response here is JSON, never HTML, so `default-src 'none'` is safe: there
 * is nothing on these routes a CSP would need to permit loading.
 */
function applySecurityHeaders(res: VercelResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  res.setHeader("Content-Security-Policy", "default-src 'none'");
}

/**
 * Set CORS and baseline security headers, and handle preflight. Returns true
 * when the request was a preflight OPTIONS and has been fully handled — the
 * caller should return immediately in that case.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  applySecurityHeaders(res);
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * Reject any method other than GET on a read-only route. Returns true when a
 * 405 has already been sent, so callers use `if (requireGetMethod(req, res))
 * return;`.
 */
export function requireGetMethod(
  req: VercelRequest,
  res: VercelResponse
): boolean {
  if (req.method === "GET") return false;
  res.setHeader("Allow", "GET");
  res.status(405).json({ error: "Method not allowed" });
  return true;
}

export {
  MAINNET_VAULT_CACHE_CONTROL,
  TESTNET_VAULT_CACHE_CONTROL,
  HISTORY_CACHE_CONTROL,
  vaultReadCacheControl,
};

/**
 * Cache-Control for GET /api/v1/config responses. Returns a short cache policy
 * when complete, or no-store if active adapter resolution degraded so transient
 * RPC errors are not cached at the edge.
 */
export function configCacheControl(degraded = false): string {
  return degraded ? "no-store" : CONFIG_CACHE_CONTROL;
}

function clientIp(req: VercelRequest): string {
  const vercelHeader = req.headers["x-vercel-forwarded-for"];
  const vercelValue = Array.isArray(vercelHeader)
    ? vercelHeader[0]
    : vercelHeader;
  const vercelIp = vercelValue?.split(",")[0]?.trim();
  if (vercelIp && isIP(vercelIp)) return vercelIp;

  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Enforces strict distributed rate limiting for fund-moving or keeper endpoints.
 * Returns false and sends a 503 HTTP response if Redis is missing on any
 * deployment. Only true local dev (no VERCEL_ENV at all) may fall back to the
 * in-memory limiter: preview deployments have their own public URL, so they
 * serve real traffic to these routes just like production.
 */
export function enforceStrictRateLimit(res: VercelResponse): boolean {
  const isLocalDev = process.env.VERCEL_ENV === undefined;

  if (!isLocalDev && !isDistributedRateLimitingConfigured()) {
    res.status(503).json({
      error:
        "Service Unavailable: Distributed rate limiting is required on deployed environments for this route.",
      code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
    });
    return false;
  }

  return true;
}

export interface RateLimitOptions {
  /** Policy to enforce. Defaults to the read policy. */
  route?: RateLimitRoute;
  /** Overrides the policy's distributed-store requirement. */
  strict?: boolean;
  /**
   * Namespaces the rate-limit counter. Routes that pass a bucket spend their
   * own budget per IP instead of sharing the default one, so noisy low-value
   * traffic (for example CSP violation reports) cannot starve other routes.
   */
  bucket?: string;
}

/**
 * Check rate limit for the incoming request.
 * - The route selects the policy: reads, transaction builds, transaction
 *   submits, keepers, and admin routes each get their own budget.
 * - Transaction submits also key on the wallet, but only when the XDR carries
 *   a signature from that wallet; rotating IPs does not reset a wallet's
 *   budget, and naming someone else's address does not spend it.
 * - `strict` (or a strict policy) returns 503 when Upstash is unconfigured on
 *   any deployment; only local dev without VERCEL_ENV falls back to memory.
 * - Pass `bucket` to give a route its own counter instead of the shared per-IP
 *   one.
 * Writes standard RateLimit headers, and a 429 or 503 response, returning
 * false when blocked.
 */
export async function checkRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  options: RateLimitOptions = {}
): Promise<boolean> {
  const route = options.route ?? "read";
  const policy = resolveRateLimitPolicy(route);
  const strict = options.strict ?? policy.strict;

  if (strict && !enforceStrictRateLimit(res)) {
    return false;
  }

  const decision = await enforceRateLimit(
    distributedStore ?? memoryStore,
    route,
    {
      ip: clientIp(req),
      wallet: verifiedWalletFromRequest(req.body),
      bucket: options.bucket,
    }
  );

  for (const [name, value] of Object.entries(decision.headers)) {
    res.setHeader(name, value);
  }

  if (!decision.allowed) {
    res.status(429).json({
      error: "Too many requests. Try again in a minute.",
    });
    return false;
  }
  return true;
}

function authorizationHeader(req: VercelRequest): string | undefined {
  const raw = req.headers.authorization;
  return Array.isArray(raw) ? raw[0] : raw;
}

// Constant-time comparison: these endpoints authorize real signed
// transactions, so the bearer token check shouldn't leak timing information
// a network attacker could use to guess CRON_SECRET character-by-character.
// Both inputs are hashed to a fixed 32-byte digest first, so there's no
// length-based short-circuit before timingSafeEqual, a naive length check up
// front would itself leak the secret's length via timing before the
// constant-time comparison ever ran.
function safeCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

// The one place "is CRON_SECRET effectively required right now" is
// defined. Both a handler's own pre-check (returning a distinct 503 for
// "not configured" before ever looking at the request) and
// isCronAuthorized's internal permissive-local-dev fallback need this same
// condition; deriving it independently in more than one place risks the
// two silently diverging.
export function isCronSecretConfigured(): boolean {
  return (
    Boolean(process.env.CRON_SECRET) || process.env.VERCEL_ENV === undefined
  );
}

/**
 * Authorizes a Vercel Cron-invoked endpoint via the shared CRON_SECRET
 * bearer token. Permissive only for true local dev (no VERCEL_ENV at all);
 * preview deployments have their own public URL and, unlike simple
 * rate-limit relaxation elsewhere, these endpoints trigger real signed
 * transactions off a funded keeper account, so an unauthenticated preview
 * caller could drain its balance (or, for the migration keeper, move a real
 * vault position) by spamming the endpoint. Preview and production both
 * require CRON_SECRET.
 */
export function isCronAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return isCronSecretConfigured();
  return safeCompare(authorizationHeader(req) ?? "", `Bearer ${secret}`);
}
