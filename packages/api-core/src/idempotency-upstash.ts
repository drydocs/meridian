import { withRaceTimeout } from "@meridian/shared";
import {
  createInMemoryIdempotencyStore,
  type CompletedIdempotencyRecord,
  type IdempotencyRecord,
  type IdempotencyStore,
  type ProcessingIdempotencyRecord,
  type StoredIdempotencyRecord,
} from "./idempotency";

export const DEFAULT_IDEMPOTENCY_STORE_TIMEOUT_MS = 5_000;

// Keep local requests in the same process on one store so retries can replay.
const localIdempotencyStore = createInMemoryIdempotencyStore();

const RENEW_IF_OWNER =
  "local value = redis.call('GET', KEYS[1]); if value == ARGV[1] then local record = cjson.decode(value); local renewed = cjson.decode(ARGV[3]); if record.state == 'processing' and record.ownerToken == ARGV[2] and renewed.state == 'processing' and renewed.ownerToken == ARGV[2] and renewed.requestHash == record.requestHash then redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4]); return 1 end end; return 0";
const FINALIZE_IF_OWNER =
  "local value = redis.call('GET', KEYS[1]); if value == ARGV[1] then local record = cjson.decode(value); if record.state == 'processing' and record.ownerToken == ARGV[2] and record.requestHash == ARGV[3] then redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5]); return 1 end end; return 0";
const MARK_UNKNOWN_IF_OWNER =
  "local value = redis.call('GET', KEYS[1]); if value == ARGV[1] then local old = cjson.decode(value); local next = cjson.decode(ARGV[3]); if old.state == 'processing' and old.ownerToken == ARGV[2] and old.requestHash == next.requestHash and next.state == 'outcome_unknown' and next.ownerToken == ARGV[2] then redis.call('SET', KEYS[1], ARGV[3]); return 1 end end; return 0";
const RESOLVE_UNKNOWN_IF_OWNER =
  "local value = redis.call('GET', KEYS[1]); if value == ARGV[1] then local old = cjson.decode(value); local next = cjson.decode(ARGV[4]); if old.state == 'outcome_unknown' and old.ownerToken == ARGV[2] and old.requestHash == next.requestHash and old.transactionHash == ARGV[3] and next.state == 'completed' and next.ownerToken == ARGV[2] then redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5]); return 1 end end; return 0";

/**
 * Upstash REST implementation of the framework-independent store contract.
 * All mutations that depend on ownership are atomic Lua scripts.
 */
export function createUpstashIdempotencyStore(options: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): IdempotencyStore {
  const url = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDEMPOTENCY_STORE_TIMEOUT_MS;

  async function command(args: (string | number)[]): Promise<unknown> {
    const response = await withRaceTimeout(
      () =>
        fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
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
    if (!("result" in body)) {
      throw new Error("Upstash Redis response did not include a result");
    }
    return body.result;
  }

  return {
    async get(key) {
      const value = await command(["GET", key]);
      if (value === null) return null;
      if (typeof value !== "string") {
        throw new Error("Upstash Redis returned an invalid idempotency value");
      }
      return storedRecord(value);
    },
    async claim(key, record, leaseTtlMs) {
      const value = serialize(record);
      const result = await command([
        "SET",
        key,
        value,
        "NX",
        "PX",
        expiry(leaseTtlMs),
      ]);
      if (result === null) return null;
      if (result !== "OK") {
        throw new Error("Upstash Redis returned an invalid claim result");
      }
      return { record, revision: value };
    },
    async renew(key, ownerToken, expectedRevision, updatedAtMs, leaseTtlMs) {
      const current = storedRecord(expectedRevision);
      if (
        current.record.state !== "processing" ||
        current.record.ownerToken !== ownerToken
      ) {
        return null;
      }
      const renewed: ProcessingIdempotencyRecord = {
        ...current.record,
        updatedAtMs,
      };
      const value = serialize(renewed);
      const result = await command([
        "EVAL",
        RENEW_IF_OWNER,
        1,
        key,
        expectedRevision,
        ownerToken,
        value,
        expiry(leaseTtlMs),
      ]);
      if (Number(result) !== 1) return null;
      return { record: renewed, revision: value };
    },
    async finalize(
      key,
      ownerToken,
      expectedRevision,
      record,
      resultTtlMs
    ) {
      if (record.ownerToken !== ownerToken) {
        throw new Error("Cannot finalize an idempotency key owned by another request");
      }
      const value = serialize(record);
      const result = await command([
        "EVAL",
        FINALIZE_IF_OWNER,
        1,
        key,
        expectedRevision,
        ownerToken,
        record.requestHash,
        value,
        expiry(resultTtlMs),
      ]);
      if (Number(result) !== 1) return null;
      return { record, revision: value };
    },
    async markOutcomeUnknown(key, ownerToken, expectedRevision, record) {
      const value = serialize(record);
      const result = await command([
        "EVAL", MARK_UNKNOWN_IF_OWNER, 1, key,
        expectedRevision, ownerToken, value,
      ]);
      if (Number(result) !== 1) return null;
      return { record, revision: value };
    },
    async resolveOutcomeUnknown(key, ownerToken, expectedRevision, record, resultTtlMs) {
      if (record.ownerToken !== ownerToken) {
        throw new Error("Cannot resolve an idempotency key owned by another request");
      }
      const current = storedRecord(expectedRevision);
      if (current.record.state !== "outcome_unknown") return null;
      const value = serialize(record);
      const result = await command([
        "EVAL", RESOLVE_UNKNOWN_IF_OWNER, 1, key,
        expectedRevision, ownerToken, current.record.transactionHash,
        value, expiry(resultTtlMs),
      ]);
      if (Number(result) !== 1) return null;
      return { record, revision: value };
    },
  };
}

/** Resolve the same standard and Vercel Marketplace credentials as the API. */
export function loadUpstashIdempotencyStore(
  env: Record<string, string | undefined>,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): IdempotencyStore {
  const url = (
    env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_REST_KV_REST_API_URL
  )?.trim();
  const token = (
    env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  )?.trim();
  if (!url || !token) {
    throw new Error("Upstash Redis REST URL and token are required");
  }
  return createUpstashIdempotencyStore({
    url,
    token,
    ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
}

/** Use process-local state only for genuine, non-production local development. */
export function loadIdempotencyStore(
  env: Record<string, string | undefined>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): IdempotencyStore {
  const url = (
    env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_REST_KV_REST_API_URL
  )?.trim();
  const token = (
    env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  )?.trim();
  if (url && token) return loadUpstashIdempotencyStore(env, options);

  const deployed =
    env.VERCEL_ENV !== undefined ||
    env.DEPLOYMENT_ENV !== undefined ||
    Boolean(env.VERCEL);
  if (!deployed && env.NODE_ENV !== "production") return localIdempotencyStore;
  throw new Error("Upstash Redis REST URL and token are required");
}

function serialize(record: IdempotencyRecord): string {
  const value = JSON.stringify(record);
  if (value === undefined) {
    throw new TypeError("Idempotency record is not serializable");
  }
  return value;
}

function storedRecord(value: string): StoredIdempotencyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Upstash Redis contains malformed idempotency JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Upstash Redis contains an invalid idempotency record");
  }
  return { record: parsed, revision: value };
}

function isRecord(value: unknown): value is IdempotencyRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestHash !== "string" ||
    typeof record.ownerToken !== "string"
  ) {
    return false;
  }
  if (record.state === "processing") {
    return (
      typeof record.createdAtMs === "number" &&
      Number.isFinite(record.createdAtMs) &&
      typeof record.updatedAtMs === "number" &&
      Number.isFinite(record.updatedAtMs)
    );
  }
  if (record.state === "completed") {
    const response = record.response as
      | CompletedIdempotencyRecord["response"]
      | undefined;
    return (
      typeof record.completedAtMs === "number" &&
      Number.isFinite(record.completedAtMs) &&
      typeof response === "object" &&
      response !== null &&
      Number.isInteger(response.status) &&
      Object.prototype.hasOwnProperty.call(response, "body")
    );
  }
  if (record.state === "outcome_unknown") {
    const validMaxTime = typeof record.maxTime === "string" &&
      /^\d+$/.test(record.maxTime) && BigInt(record.maxTime) > 0n;
    const validMaxLedger = typeof record.maxLedger === "number" &&
      Number.isSafeInteger(record.maxLedger) && record.maxLedger > 0;
    const validStartLedger = record.submissionStartLedger === null ||
      (typeof record.submissionStartLedger === "number" &&
        Number.isSafeInteger(record.submissionStartLedger) &&
        record.submissionStartLedger >= 0);
    return /^[\da-f]{64}$/i.test(record.requestHash) &&
      record.ownerToken.length > 0 &&
      /^[\da-f]{64}$/i.test(String(record.transactionHash)) &&
      typeof record.signedXdr === "string" && record.signedXdr.length > 0 &&
      (record.network === "mainnet" || record.network === "testnet" ||
        record.network === "futurenet") &&
      typeof record.sourceAccount === "string" && record.sourceAccount.length > 0 &&
      typeof record.sequence === "string" && /^\d+$/.test(record.sequence) &&
      (validMaxTime || validMaxLedger) &&
      (record.maxTime === null || validMaxTime) &&
      (record.maxLedger === null || validMaxLedger) &&
      validStartLedger &&
      typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs) &&
      typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs);
  }
  return false;
}

function expiry(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("Idempotency TTL must be a positive number");
  }
  return Math.max(1, Math.ceil(ttlMs));
}
