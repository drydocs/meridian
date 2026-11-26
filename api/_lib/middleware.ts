import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Buffer } from "node:buffer";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { DEFAULT_ALLOWED_ORIGIN, MAX_BODY_BYTES } from "@meridian/shared";
import {
  createRequestId,
  responseBody,
  REQUEST_ID_HEADER,
  CONFIG_CACHE_CONTROL,
  MAINNET_VAULT_CACHE_CONTROL,
  TESTNET_VAULT_CACHE_CONTROL,
  HISTORY_CACHE_CONTROL,
  vaultReadCacheControl,
} from "@meridian/api-core";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? DEFAULT_ALLOWED_ORIGIN;

export { MAX_BODY_BYTES };

export const PAYLOAD_TOO_LARGE_ERROR = {
  error: "Payload too large",
  code: "PAYLOAD_TOO_LARGE",
} as const;

export function sendPayloadTooLarge(
  req: VercelRequest,
  res: VercelResponse
): boolean {
  sendResponse(req, res, 413, PAYLOAD_TOO_LARGE_ERROR);
  return true;
}

export interface ReadJsonBodyResult {
  ok: boolean;
  body?: unknown;
}

function contentLength(req: VercelRequest): number | undefined {
  const raw = req.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function byteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MAX_BODY_BYTES + 1;
  }
}

/**
 * Reads and parses a JSON request body with a hard 10 KB ceiling.
 * Content-Length is used only as an early rejection hint; the bytes actually
 * received are always counted and checked before JSON parsing.
 */
export async function readJsonBody(
  req: VercelRequest,
  res: VercelResponse
): Promise<ReadJsonBodyResult> {
  const declaredLength = contentLength(req);
  if (declaredLength !== undefined && declaredLength > MAX_BODY_BYTES) {
    sendPayloadTooLarge(req, res);
    return { ok: false };
  }

  const iterable = req as VercelRequest & {
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  };

  if (typeof iterable[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let total = 0;
    let payloadTooLarge = false;
    const stream = iterable as unknown as AsyncIterable<Uint8Array | string>;

    try {
      for await (const chunk of stream) {
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf8")
            : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > MAX_BODY_BYTES) {
          payloadTooLarge = true;
          if (
            typeof (req as { destroy?: (error?: Error) => void }).destroy ===
            "function"
          ) {
            (req as { destroy: (error?: Error) => void }).destroy();
          }
          sendPayloadTooLarge(req, res);
          return { ok: false };
        }
        chunks.push(bytes);
      }
    } catch {
      if (payloadTooLarge) return { ok: false };
      sendResponse(req, res, 400, { error: "Malformed JSON" });
      return { ok: false };
    }

    if (total > 0) {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        return { ok: true, body: JSON.parse(raw) };
      } catch {
        sendResponse(req, res, 400, { error: "Malformed JSON" });
        return { ok: false };
      }
    }
  }

  // Vercel may expose an already-parsed body without a readable stream. Check
  // the actual serialized size rather than trusting req.headers blindly.
  if (req.body !== undefined) {
    if (byteLength(req.body) > MAX_BODY_BYTES) {
      sendPayloadTooLarge(req, res);
      return { ok: false };
    }
    if (typeof req.body === "string") {
      try {
        return { ok: true, body: JSON.parse(req.body) };
      } catch {
        sendResponse(req, res, 400, { error: "Malformed JSON" });
        return { ok: false };
      }
    }
    return { ok: true, body: req.body };
  }

  return { ok: true, body: undefined };
}

const LIMIT = 100;
const WINDOW = "60 s";
const WINDOW_MS = 60_000;
const REQUEST_ID_PROPERTY = "__meridianRequestId";

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

const ratelimit = UPSTASH_CONFIGURED
  ? new Ratelimit({
      redis: new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! }),
      limiter: Ratelimit.slidingWindow(LIMIT, WINDOW),
    })
  : null;

const counts = new Map<string, { n: number; resetAt: number }>();

/** Clears all in-memory rate-limit buckets. Exposed for tests only. */
export function resetRateLimitForTesting(): void {
  counts.clear();
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

function incomingRequestId(req: VercelRequest): unknown {
  const value = req.headers[REQUEST_ID_HEADER.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function getRequestId(req: VercelRequest): string {
  const request = req as VercelRequest & { [REQUEST_ID_PROPERTY]?: string };
  if (request[REQUEST_ID_PROPERTY]) return request[REQUEST_ID_PROPERTY];
  const requestId = createRequestId(incomingRequestId(req));
  request[REQUEST_ID_PROPERTY] = requestId;
  return requestId;
}

export function sendResponse(
  req: VercelRequest,
  res: VercelResponse,
  status: number,
  body: unknown
): VercelResponse {
  const requestId = getRequestId(req);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  return res.status(status).json(responseBody(status, body, requestId));
}

/**
 * Set CORS and baseline security headers, and handle preflight. Returns true
 * when the request was a preflight OPTIONS and has been fully handled — the
 * caller should return immediately in that case.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  applySecurityHeaders(res);
  res.setHeader(REQUEST_ID_HEADER, getRequestId(req));
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Request-ID");
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
  sendResponse(req, res, 405, { error: "Method not allowed" });
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
export function enforceStrictRateLimit(
  req: VercelRequest,
  res: VercelResponse
): boolean {
  const isLocalDev = process.env.VERCEL_ENV === undefined;

  if (!isLocalDev && !isDistributedRateLimitingConfigured()) {
    sendResponse(req, res, 503, {
      error:
        "Service Unavailable: Distributed rate limiting is required on deployed environments for this route.",
      code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
    });
    return false;
  }

  return true;
}

export interface RateLimitOptions {
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
 * - If strict: true (fund-moving/keeper endpoints), returns 503 if Upstash is unconfigured on any deployment (only local dev without VERCEL_ENV falls back).
 * - For non-strict routes (read-only), falls back to the in-memory rate limiter.
 * - Pass `bucket` to give a route its own counter instead of the shared per-IP one.
 * Writes a 429 or 503 response and returns false when blocked.
 */
export async function checkRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  options: RateLimitOptions = {}
): Promise<boolean> {
  const { strict = false, bucket } = options;

  if (strict && !enforceStrictRateLimit(req, res)) {
    return false;
  }

  const ip = clientIp(req);
  const key = bucket ? `${bucket}:${ip}` : ip;

  if (ratelimit) {
    const { success, limit, remaining, reset } = await ratelimit.limit(key);
    res.setHeader("x-ratelimit-limit", String(limit));
    res.setHeader("x-ratelimit-remaining", String(remaining));
    res.setHeader(
      "x-ratelimit-reset",
      String(Math.max(1, Math.ceil((reset - Date.now()) / 1000)))
    );
    if (!success) {
      res.setHeader("retry-after", "60");
      sendResponse(req, res, 429, {
        error: "Too many requests. Try again in a minute.",
      });
      return false;
    }
    return true;
  }

  // In-memory fallback
  const now = Date.now();
  const entry = counts.get(key);
  if (!entry || now > entry.resetAt) {
    counts.set(key, { n: 1, resetAt: now + WINDOW_MS });
    res.setHeader("x-ratelimit-limit", String(LIMIT));
    res.setHeader("x-ratelimit-remaining", String(LIMIT - 1));
    res.setHeader("x-ratelimit-reset", "60");
    return true;
  }
  if (entry.n >= LIMIT) {
    res.setHeader("x-ratelimit-limit", String(LIMIT));
    res.setHeader("x-ratelimit-remaining", "0");
    res.setHeader(
      "x-ratelimit-reset",
      String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000)))
    );
    res.setHeader("retry-after", "60");
    sendResponse(req, res, 429, {
      error: "Too many requests. Try again in a minute.",
    });
    return false;
  }
  entry.n++;
  res.setHeader("x-ratelimit-limit", String(LIMIT));
  res.setHeader("x-ratelimit-remaining", String(LIMIT - entry.n));
  res.setHeader(
    "x-ratelimit-reset",
    String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000)))
  );
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
