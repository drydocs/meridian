/**
 * Shared vault list cache for serverless cold starts (#811).
 *
 * `vaults.ts` used to keep an in-process `vaultCache`. That helps warm
 * invocations on the same Lambda instance, but every Vercel cold start
 * starts with an empty module scope and pays the DeFiLlama/chain round
 * trip (~200-500ms) again. This module stores the same payload in Upstash
 * Redis (already provisioned for keeper-state) so all invocations share it.
 *
 * Spoken over plain `fetch` rather than `@upstash/redis`, matching
 * `keeper-state.ts` / `rate-sources.ts`: this package has no Redis
 * dependency today, and a handful of Redis commands don't justify one.
 *
 * When Upstash credentials are missing the helpers no-op (get → null,
 * set → ignored) so local/dev and unit tests keep using the in-memory
 * cache in `vaults.ts` alone.
 *
 * Stale serving (#stale): `getCachedVaultsWithAge` reads the stored entry
 * and returns both the payload and the age in seconds even when the TTL has
 * expired on the Redis side, using a separate long-lived shadow key so
 * callers can serve a marked-stale response during an upstream outage.
 *
 * Circuit breaker: `incrementBreakerFailures` / `clearBreakerFailures`
 * maintain a short-lived INCR counter per network. `getBreakerFailures`
 * reads the current failure count. The caller in `vaults.ts` trips the
 * breaker after a configured threshold and skips live fetches for the
 * duration of the breaker window, serving stale data instead.
 */

import { withRaceTimeout } from "@meridian/shared";
import type { ApiVault } from "./vaults";

/** Aligns with CDN `s-maxage=60` on `/api/v1/vaults`. */
export const VAULT_CACHE_TTL_SECONDS = 60;

/**
 * Shadow key TTL for stale serving. Much longer than the live TTL so an
 * expired entry survives an outage and can be served with a stale flag.
 */
export const VAULT_SHADOW_TTL_SECONDS = 3600; // 1 hour

/**
 * Circuit breaker window: how long (in seconds) a failure counter key lives
 * in Redis before it auto-expires and the breaker resets passively.
 */
export const BREAKER_WINDOW_SECONDS = 30;

const DEFAULT_STORE_TIMEOUT_MS = 5_000;

export function vaultCacheKey(network: string): string {
  return `vault-cache:${network}`;
}

/** Key for the long-lived shadow entry used for stale serving. */
export function vaultShadowKey(network: string): string {
  return `vault-cache-shadow:${network}`;
}

/** Key for the circuit breaker failure counter. */
export function vaultBreakerKey(network: string): string {
  return `vault-breaker:${network}`;
}

function resolveUpstashCreds(
  env: Record<string, string | undefined>
): { url: string; token: string } | null {
  // Vercel's Upstash Marketplace integration provisions store-prefixed names;
  // accept either those or the plain UPSTASH_REDIS_REST_* pair.
  const restUrl = (
    env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_REST_KV_REST_API_URL
  )?.trim();
  const restToken = (
    env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  )?.trim();
  if (!restUrl || !restToken) return null;
  return { url: restUrl.replace(/\/+$/, ""), token: restToken };
}

export interface VaultCacheOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlSeconds?: number;
  shadowTtlSeconds?: number;
}

/**
 * Logs a cache failure with the error's message only. The messages thrown by
 * `upstashCommand` carry the HTTP status or Redis error text, never the store
 * URL or token, so the log surfaces a misconfigured cache without leaking
 * credentials.
 */
function logCacheFailure(op: "read" | "write", error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[vault-cache] ${op} failed: ${detail}`);
}

async function upstashCommand(
  args: (string | number)[],
  options: VaultCacheOptions = {}
): Promise<unknown | null> {
  const creds = resolveUpstashCreds(options.env ?? process.env);
  if (!creds) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;

  const response = await withRaceTimeout(
    () =>
      fetchImpl(creds.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    timeoutMs,
    "Upstash Redis"
  );

  if (!response.ok) {
    throw new Error(
      `Upstash Redis request failed with HTTP ${response.status}`
    );
  }

  const body = (await response.json()) as {
    result?: unknown;
    error?: string;
  };
  if (body.error) throw new Error(`Upstash Redis error: ${body.error}`);
  return body.result ?? null;
}

/**
 * Reads the shared vault list for `network`. Returns null on miss, missing
 * credentials, or any store error (callers fall through to DeFiLlama).
 */
export async function getCachedVaults(
  network: "mainnet" | "testnet",
  options: VaultCacheOptions = {}
): Promise<ApiVault[] | null> {
  try {
    const value = await upstashCommand(
      ["GET", vaultCacheKey(network)],
      options
    );
    if (typeof value !== "string" || !value) return null;
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as ApiVault[];
  } catch (error) {
    logCacheFailure("read", error);
    return null;
  }
}

/**
 * Writes the vault list for `network` with a 60s Redis TTL (SETEX).
 * Also writes a long-lived shadow key (default 1 h) so stale data can be
 * served during an upstream outage even after the primary key expires.
 * No-ops when Upstash is not configured; swallows store errors so a Redis
 * blip never fails the vaults endpoint.
 */
export async function setCachedVaults(
  network: "mainnet" | "testnet",
  vaults: ApiVault[],
  options: VaultCacheOptions = {}
): Promise<void> {
  const ttl = options.ttlSeconds ?? VAULT_CACHE_TTL_SECONDS;
  const shadowTtl = options.shadowTtlSeconds ?? VAULT_SHADOW_TTL_SECONDS;
  const payload = JSON.stringify(vaults);
  try {
    // Pipeline both writes as a single Upstash batch request.
    await upstashCommand(
      ["SETEX", vaultCacheKey(network), ttl, payload],
      options
    );
    await upstashCommand(
      ["SETEX", vaultShadowKey(network), shadowTtl, payload],
      options
    );
  } catch (error) {
    // Shared cache is best-effort; in-memory still covers this instance.
    logCacheFailure("write", error);
  }
}

/** The result of a stale-aware shared cache read. */
export interface StaleCacheResult {
  vaults: ApiVault[];
  /**
   * Seconds since the shadow entry was last written. This is derived from
   * the Redis key's remaining TTL: `shadowTtl - remainingTtl`.
   * Returns null when the age cannot be determined (Upstash not configured,
   * TTL command unavailable, etc.).
   */
  cacheAgeSeconds: number | null;
}

/**
 * Reads the long-lived shadow key and returns the last known vault list
 * regardless of whether the primary TTL has expired. Used during upstream
 * outages to serve a stale but non-empty payload.
 *
 * Returns null on miss, missing credentials, or any store error.
 */
export async function getCachedVaultsStale(
  network: "mainnet" | "testnet",
  options: VaultCacheOptions = {}
): Promise<StaleCacheResult | null> {
  try {
    const shadowTtl = options.shadowTtlSeconds ?? VAULT_SHADOW_TTL_SECONDS;
    const key = vaultShadowKey(network);

    // Fetch value and remaining TTL in parallel to minimise latency.
    const [value, ttlRaw] = await Promise.all([
      upstashCommand(["GET", key], options),
      upstashCommand(["TTL", key], options),
    ]);

    if (typeof value !== "string" || !value) return null;
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;

    // TTL command returns remaining seconds, or -1 (no expiry), -2 (missing).
    const remainingTtl =
      typeof ttlRaw === "number" && ttlRaw >= 0 ? ttlRaw : null;
    const cacheAgeSeconds =
      remainingTtl !== null ? shadowTtl - remainingTtl : null;

    return { vaults: parsed as ApiVault[], cacheAgeSeconds };
  } catch (error) {
    logCacheFailure("read", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Increments the failure counter for `network` and sets a TTL of
 * `BREAKER_WINDOW_SECONDS` on first write (NX logic via INCR + EXPIRE).
 * Returns the new failure count, or null when Upstash is not configured or
 * the write fails (callers treat null as "breaker not tripped").
 */
export async function incrementBreakerFailures(
  network: "mainnet" | "testnet",
  options: VaultCacheOptions = {}
): Promise<number | null> {
  try {
    const key = vaultBreakerKey(network);
    const count = await upstashCommand(["INCR", key], options);
    if (typeof count !== "number") return null;
    // Set the expiry only when the counter was just created (count === 1) so
    // subsequent INCRs within the window don't reset the clock.
    if (count === 1) {
      await upstashCommand(["EXPIRE", key, BREAKER_WINDOW_SECONDS], options);
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Returns the current failure count for `network`.
 * Returns 0 when Upstash is not configured, the key is absent, or the read
 * fails — in all those cases the breaker is treated as closed.
 */
export async function getBreakerFailures(
  network: "mainnet" | "testnet",
  options: VaultCacheOptions = {}
): Promise<number> {
  try {
    const value = await upstashCommand(
      ["GET", vaultBreakerKey(network)],
      options
    );
    if (typeof value !== "string" || !value) return 0;
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Clears the circuit breaker for `network` after a successful probe.
 * No-ops when Upstash is not configured; swallows errors (a failed clear is
 * harmless — the key expires on its own after BREAKER_WINDOW_SECONDS).
 */
export async function clearBreakerFailures(
  network: "mainnet" | "testnet",
  options: VaultCacheOptions = {}
): Promise<void> {
  try {
    await upstashCommand(["DEL", vaultBreakerKey(network)], options);
  } catch {
    // Best-effort: the key expires automatically.
  }
}
