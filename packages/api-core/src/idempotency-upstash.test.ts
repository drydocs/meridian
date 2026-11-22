import { describe, expect, it, vi } from "vitest";
import {
  createUpstashIdempotencyStore,
  loadUpstashIdempotencyStore,
} from "./idempotency-upstash";
import type {
  ProcessingIdempotencyRecord,
  UnknownSubmissionRecord,
} from "./idempotency";

const KEY = "meridian:tx:deposit:key-digest";
const PROCESSING: ProcessingIdempotencyRecord = {
  state: "processing",
  requestHash: "a".repeat(64),
  ownerToken: "owner-token",
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};
const PROCESSING_JSON = JSON.stringify(PROCESSING);
const UNKNOWN: UnknownSubmissionRecord = {
  state: "outcome_unknown",
  requestHash: "a".repeat(64),
  ownerToken: "owner-token",
  transactionHash: "a".repeat(64),
  signedXdr: "SIGNED_XDR",
  network: "testnet",
  sourceAccount: "G_SOURCE",
  sequence: "42",
  maxTime: "2000",
  maxLedger: null,
  submissionStartLedger: 10,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};

function fetchMock(result: unknown, options: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => result,
  })) as unknown as typeof fetch;
}

describe("createUpstashIdempotencyStore", () => {
  it("claims with one atomic SET NX PX command", async () => {
    const fetchImpl = fetchMock({ result: "OK" });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example/",
      token: "secret",
      fetchImpl,
    });

    expect(await store.claim(KEY, PROCESSING, 5_000)).toMatchObject({
      record: PROCESSING,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify([
          "SET",
          KEY,
          PROCESSING_JSON,
          "NX",
          "PX",
          5_000,
        ]),
      })
    );
  });

  it("reports a competing atomic claim without treating it as a storage failure", async () => {
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl: fetchMock({ result: null }),
    });

    expect(await store.claim(KEY, PROCESSING, 5_000)).toBeNull();
  });

  it("reads the stored record and preserves its exact revision", async () => {
    const fetchImpl = fetchMock({ result: PROCESSING_JSON });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl,
    });

    expect(await store.get(KEY)).toEqual({
      record: PROCESSING,
      revision: PROCESSING_JSON,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({ body: JSON.stringify(["GET", KEY]) })
    );
  });

  it("renews only the exact processing revision owned by the caller", async () => {
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl,
    });

    expect(
      await store.renew(KEY, "owner-token", PROCESSING_JSON, 2_000, 5_000)
    ).toEqual({
      record: { ...PROCESSING, updatedAtMs: 2_000 },
      revision: JSON.stringify({ ...PROCESSING, updatedAtMs: 2_000 }),
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const args = JSON.parse(String(init.body)) as unknown[];
    expect(args[0]).toBe("EVAL");
    expect(args[3]).toBe(KEY);
    expect(args[4]).toBe(PROCESSING_JSON);
    expect(args[5]).toBe("owner-token");
    expect(args[6]).toBe(JSON.stringify({ ...PROCESSING, updatedAtMs: 2_000 }));
    expect(args[7]).toBe(5_000);
  });

  it("finalizes with an atomic owner and revision check", async () => {
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl,
    });
    const completed = {
      state: "completed" as const,
      requestHash: PROCESSING.requestHash,
      ownerToken: "owner-token",
      response: { status: 200, body: { hash: "TX_HASH" } },
      completedAtMs: 1_500,
    };

    expect(
      await store.finalize(
        KEY,
        "owner-token",
        PROCESSING_JSON,
        completed,
        86_400_000
      )
    ).toEqual({ record: completed, revision: JSON.stringify(completed) });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const args = JSON.parse(String(init.body)) as unknown[];
    expect(args[0]).toBe("EVAL");
    expect(args[3]).toBe(KEY);
    expect(args[4]).toBe(PROCESSING_JSON);
    expect(args[5]).toBe("owner-token");
    expect(args[6]).toBe(PROCESSING.requestHash);
    expect(args[7]).toBe(JSON.stringify(completed));
    expect(args[8]).toBe(86_400_000);
  });

  it("refuses to finalize using a different owner token", async () => {
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl,
    });

    await expect(
      store.finalize(
        KEY,
        "owner-two",
        PROCESSING_JSON,
        {
          state: "completed",
          requestHash: PROCESSING.requestHash,
          ownerToken: "owner-one",
          response: { status: 200, body: {} },
          completedAtMs: 1_500,
        },
        1_000
      )
    ).rejects.toThrow(/another request/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks outcome unknown atomically without assigning an expiring lease", async () => {
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example", token: "secret", fetchImpl,
    });
    const unknownJson = JSON.stringify(UNKNOWN);

    expect(await store.markOutcomeUnknown(
      KEY, "owner-token", PROCESSING_JSON, UNKNOWN
    )).toEqual({ record: UNKNOWN, revision: unknownJson });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const args = JSON.parse(String(init.body)) as unknown[];
    expect(args.slice(0, 5)).toEqual([
      "EVAL", expect.any(String), 1, KEY, PROCESSING_JSON,
    ]);
    expect(args.slice(5)).toEqual(["owner-token", unknownJson]);
    expect(String(args[1])).toContain("SET', KEYS[1], ARGV[3]");
    expect(String(args[1])).not.toContain("'PX'");
  });

  it("resolves unknown only with owner and transaction identity CAS", async () => {
    const fetchImpl = fetchMock({ result: 1 });
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example", token: "secret", fetchImpl,
    });
    const unknownJson = JSON.stringify(UNKNOWN);
    const completed = {
      state: "completed" as const,
      requestHash: UNKNOWN.requestHash,
      ownerToken: UNKNOWN.ownerToken,
      resolution: "SUCCESS" as const,
      response: { status: 200, body: { hash: UNKNOWN.transactionHash } },
      completedAtMs: 2_000,
    };

    expect(await store.resolveOutcomeUnknown(
      KEY, UNKNOWN.ownerToken, unknownJson, completed, 86_400_000
    )).toEqual({ record: completed, revision: JSON.stringify(completed) });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const args = JSON.parse(String(init.body)) as unknown[];
    expect(args[0]).toBe("EVAL");
    expect(args[4]).toBe(unknownJson);
    expect(args[5]).toBe(UNKNOWN.ownerToken);
    expect(args[6]).toBe(UNKNOWN.transactionHash);
    expect(args[7]).toBe(JSON.stringify(completed));
    expect(args[8]).toBe(86_400_000);
    expect(String(args[1])).toContain("old.transactionHash == ARGV[3]");
  });

  it("fails closed on malformed stored data", async () => {
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl: fetchMock({ result: "not-json" }),
    });

    await expect(store.get(KEY)).rejects.toThrow(/malformed idempotency JSON/);
  });

  it("rejects an unknown record without a finite validity bound", async () => {
    const invalid = {
      ...UNKNOWN,
      maxTime: null,
      maxLedger: null,
    };
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "secret",
      fetchImpl: fetchMock({ result: JSON.stringify(invalid) }),
    });

    await expect(store.get(KEY)).rejects.toThrow(/invalid idempotency record/);
  });

  it("reports Redis failures without exposing the token", async () => {
    const store = createUpstashIdempotencyStore({
      url: "https://redis.example",
      token: "do-not-leak-this-token",
      fetchImpl: fetchMock({}, { ok: false, status: 503 }),
    });

    await expect(store.get(KEY)).rejects.toThrow(
      "Upstash Redis request failed with HTTP 503"
    );
    await expect(store.get(KEY)).rejects.not.toThrow(/do-not-leak-this-token/);
  });

  it("accepts both standard and Marketplace Upstash credential names", () => {
    expect(
      loadUpstashIdempotencyStore({
        UPSTASH_REDIS_REST_KV_REST_API_URL: "https://redis.example",
        UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "secret",
      })
    ).toBeDefined();
  });
});
