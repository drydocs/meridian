import { withRaceTimeout } from "@meridian/shared";
import type { PositionInfo } from "@meridian/stellar-sdk-helpers";

export const POSITION_CACHE_TTL_SECONDS = 15;
const DEFAULT_STORE_TIMEOUT_MS = 5_000;
const MAX_MEMORY_ENTRIES = 1_000;

interface MemoryEntry {
  ledger: number;
  positions: PositionInfo[];
  expiresAt: number;
}

export interface PositionCacheOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlSeconds?: number;
}

const memoryCache = new Map<string, MemoryEntry>();

function storeMemoryEntry(key: string, entry: MemoryEntry): void {
  const now = Date.now();
  for (const [cachedKey, cachedEntry] of memoryCache) {
    if (cachedEntry.expiresAt <= now) memoryCache.delete(cachedKey);
  }
  while (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value!;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(key, entry);
}

export function positionCacheKey(
  network: string,
  publicKey: string,
  ledger: number
): string {
  return `position-cache:${network}:${publicKey}:${ledger}`;
}

function walletCacheKey(network: string, publicKey: string): string {
  return `position-cache:${network}:${publicKey}`;
}

function resolveUpstashCreds(
  env: Record<string, string | undefined>
): { url: string; token: string } | null {
  const url = (
    env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_REST_KV_REST_API_URL
  )?.trim();
  const token = (
    env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  )?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function upstashCommand(
  args: (string | number)[],
  options: PositionCacheOptions
): Promise<unknown | null> {
  const creds = resolveUpstashCreds(options.env ?? process.env);
  if (!creds) return null;

  const timeoutMs = options.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  const response = await withRaceTimeout(
    () =>
      (options.fetchImpl ?? fetch)(creds.url, {
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

  const body = (await response.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`Upstash Redis error: ${body.error}`);
  return body.result ?? null;
}

function isPositionInfo(value: unknown): value is PositionInfo {
  if (typeof value !== "object" || value === null) return false;
  const position = value as Record<string, unknown>;
  return (
    typeof position.vaultId === "string" &&
    typeof position.shares === "number" &&
    typeof position.deposited === "number" &&
    typeof position.earned === "number" &&
    typeof position.entryTime === "number"
  );
}

function parsePositions(value: unknown): PositionInfo[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(isPositionInfo)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function logCacheFailure(operation: "read" | "write", error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[position-cache] ${operation} failed: ${detail}`);
}

/** Remove stale ledgers for this wallet from the in-process cache. */
export function invalidatePositionCache(
  network: string,
  publicKey: string,
  latestLedger: number
): void {
  const prefix = `${walletCacheKey(network, publicKey)}:`;
  for (const [key, entry] of memoryCache) {
    if (key.startsWith(prefix) && entry.ledger !== latestLedger) {
      memoryCache.delete(key);
    }
  }
}

export async function getCachedPositions(
  network: string,
  publicKey: string,
  ledger: number,
  options: PositionCacheOptions = {}
): Promise<PositionInfo[] | null> {
  const key = positionCacheKey(network, publicKey, ledger);
  const entry = memoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.positions;
  if (entry) memoryCache.delete(key);

  try {
    const raw = await upstashCommand(["GET", key], options);
    const positions = parsePositions(raw);
    if (positions) {
      storeMemoryEntry(key, {
        ledger,
        positions,
        expiresAt:
          Date.now() +
          (options.ttlSeconds ?? POSITION_CACHE_TTL_SECONDS) * 1_000,
      });
    }
    return positions;
  } catch (error) {
    logCacheFailure("read", error);
    return null;
  }
}

export async function setCachedPositions(
  network: string,
  publicKey: string,
  ledger: number,
  positions: PositionInfo[],
  options: PositionCacheOptions = {}
): Promise<void> {
  const key = positionCacheKey(network, publicKey, ledger);
  const ttlSeconds = options.ttlSeconds ?? POSITION_CACHE_TTL_SECONDS;
  storeMemoryEntry(key, {
    ledger,
    positions,
    expiresAt: Date.now() + ttlSeconds * 1_000,
  });

  try {
    await upstashCommand(
      ["SETEX", key, ttlSeconds, JSON.stringify(positions)],
      options
    );
  } catch (error) {
    logCacheFailure("write", error);
  }
}

export function clearPositionCacheForTesting(): void {
  memoryCache.clear();
}
