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
 */

import { withRaceTimeout } from "@meridian/shared";
import type { ApiVault } from "./vaults";

/** Aligns with CDN `s-maxage=60` on `/api/v1/vaults`. */
export const VAULT_CACHE_TTL_SECONDS = 60;

const DEFAULT_STORE_TIMEOUT_MS = 5_000;

export function vaultCacheKey(network: string): string {
  return `vault-cache:${network}`;
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
    const value = await upstashCommand(["GET", vaultCacheKey(network)], options);
    if (typeof value !== "string" || !value) return null;
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as ApiVault[];
  } catch {
    return null;
  }
}

/**
 * Writes the vault list for `network` with a 60s Redis TTL (SETEX).
 * No-ops when Upstash is not configured; swallows store errors so a Redis
 * blip never fails the vaults endpoint.
 */
export async function setCachedVaults(
  network: "mainnet" | "testnet",
  vaults: ApiVault[],
  options: VaultCacheOptions = {}
): Promise<void> {
  const ttl = options.ttlSeconds ?? VAULT_CACHE_TTL_SECONDS;
  try {
    await upstashCommand(
      ["SETEX", vaultCacheKey(network), ttl, JSON.stringify(vaults)],
      options
    );
  } catch {
    // Shared cache is best-effort; in-memory still covers this instance.
  }
}
