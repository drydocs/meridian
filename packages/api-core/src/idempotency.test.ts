import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IDEMPOTENCY_RESULT_TTL_MS,
  createInMemoryIdempotencyStore,
  hashValidatedRequest,
  beginIdempotentSubmission,
  reconcileIdempotentSubmission,
  runNonTransactionIdempotently,
  type SubmissionIdentity,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "./idempotency";

const RESPONSE = { status: 200, body: { xdr: "BUILT_XDR" } };
const SUBMISSION: SubmissionIdentity = {
  network: "testnet",
  transactionHash: "a".repeat(64),
  signedXdr: "SIGNED_TRANSACTION_XDR",
  sourceAccount: "G_SOURCE",
  sequence: "42",
  maxTime: "2000",
  maxLedger: null,
  submissionStartLedger: 100,
};

describe("hashValidatedRequest", () => {
  it("hashes object keys in canonical order", () => {
    expect(hashValidatedRequest({ amount: "10", wallet: "GABC" })).toBe(
      hashValidatedRequest({ wallet: "GABC", amount: "10" })
    );
  });

  it("rejects a canonical request when JSON serialization returns undefined", () => {
    const stringify = vi.spyOn(JSON, "stringify").mockReturnValueOnce(
      undefined as unknown as string
    );
    expect(() => hashValidatedRequest({ amount: "10" })).toThrow(
      /not JSON serializable/
    );
    stringify.mockRestore();
  });
});

describe("runNonTransactionIdempotently", () => {
  it("persists a successful response and replays it without executing again", async () => {
    const store = createInMemoryIdempotencyStore();
    const execute = vi.fn(async () => RESPONSE);

    const first = await runNonTransactionIdempotently({
      store,
      key: "deposit:client-key",
      validatedRequest: { amount: "10", wallet: "GABC" },
      execute,
    });
    const replay = await runNonTransactionIdempotently({
      store,
      key: "deposit:client-key",
      validatedRequest: { wallet: "GABC", amount: "10" },
      execute,
    });

    expect(first).toEqual({ kind: "executed", response: RESPONSE });
    expect(replay).toEqual({ kind: "replayed", response: RESPONSE });
    expect(execute).toHaveBeenCalledOnce();
    expect(DEFAULT_IDEMPOTENCY_RESULT_TTL_MS).toBe(24 * 60 * 60 * 1_000);
  });

  it("returns conflict when a key is reused with a different request", async () => {
    const store = createInMemoryIdempotencyStore();
    await runNonTransactionIdempotently({
      store,
      key: "deposit:client-key",
      validatedRequest: { amount: "10" },
      execute: async () => RESPONSE,
    });
    const execute = vi.fn(async () => RESPONSE);

    const result = await runNonTransactionIdempotently({
      store,
      key: "deposit:client-key",
      validatedRequest: { amount: "11" },
      execute,
    });

    expect(result).toEqual({ kind: "conflict" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("replays the original non-200 status and response body", async () => {
    const store = createInMemoryIdempotencyStore();
    const response = { status: 400, body: { error: "Missing trustline" } };
    const execute = vi.fn(async () => response);

    await runNonTransactionIdempotently({
      store,
      key: "deposit:client-key",
      validatedRequest: { wallet: "GABC" },
      execute,
    });
    const replay = await runNonTransactionIdempotently({
      store,
      key: "deposit:client-key",
      validatedRequest: { wallet: "GABC" },
      execute,
    });

    expect(replay).toEqual({ kind: "replayed", response });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent owner to execute while its claim is valid", async () => {
    const store = createInMemoryIdempotencyStore();
    let finish!: (value: typeof RESPONSE) => void;
    const operation = vi.fn(
      () => new Promise<typeof RESPONSE>((resolve) => (finish = resolve))
    );
    const firstPromise = runNonTransactionIdempotently({
      store,
      key: "submit:client-key",
      validatedRequest: { xdr: "SIGNED_XDR" },
      execute: operation,
    });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());

    const second = await runNonTransactionIdempotently({
      store,
      key: "submit:client-key",
      validatedRequest: { xdr: "SIGNED_XDR" },
      execute: operation,
    });
    finish(RESPONSE);

    expect(second).toEqual({ kind: "in-progress" });
    expect(await firstPromise).toEqual({ kind: "executed", response: RESPONSE });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("expires a completed record and permits a new claim", async () => {
    let now = 1_000;
    const store = createInMemoryIdempotencyStore({ now: () => now });
    const execute = vi.fn(async () => RESPONSE);

    await runNonTransactionIdempotently({
      store,
      key: "trustline:client-key",
      validatedRequest: { wallet: "GABC" },
      resultTtlMs: 50,
      execute,
    });
    now = 1_051;
    const result = await runNonTransactionIdempotently({
      store,
      key: "trustline:client-key",
      validatedRequest: { wallet: "GABC" },
      execute,
    });

    expect(result).toEqual({ kind: "executed", response: RESPONSE });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("allows a new owner to claim after a processing lease expires", async () => {
    let now = 1_000;
    const store = createInMemoryIdempotencyStore({ now: () => now });
    const requestHash = hashValidatedRequest({ xdr: "SIGNED_XDR" });
    const original = await store.claim(
      "submit:expired-lease",
      {
        state: "processing",
        requestHash,
        ownerToken: "old-owner",
        createdAtMs: now,
        updatedAtMs: now,
      },
      50
    );
    expect(original).not.toBeNull();
    now += 51;

    const result = await runNonTransactionIdempotently({
      store,
      key: "submit:expired-lease",
      validatedRequest: { xdr: "SIGNED_XDR" },
      execute: async () => RESPONSE,
    });

    expect(result).toEqual({ kind: "executed", response: RESPONSE });
  });

  it("renews a long-running processing lease", async () => {
    const store = createInMemoryIdempotencyStore();
    const renew = vi.spyOn(store, "renew");
    const result = await runNonTransactionIdempotently({
      store,
      key: "withdraw:client-key",
      validatedRequest: { shares: "2" },
      leaseTtlMs: 100,
      renewalIntervalMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return RESPONSE;
      },
    });

    expect(result).toEqual({ kind: "executed", response: RESPONSE });
    expect(renew).toHaveBeenCalled();
  });

  it("does not release a claim when execution throws", async () => {
    const store = createInMemoryIdempotencyStore();
    await expect(
      runNonTransactionIdempotently({
        store,
        key: "submit:uncertain",
        validatedRequest: { xdr: "SIGNED_XDR" },
        execute: async () => {
          throw new Error("submission outcome unknown");
        },
      })
    ).rejects.toThrow("submission outcome unknown");

    const retry = await runNonTransactionIdempotently({
      store,
      key: "submit:uncertain",
      validatedRequest: { xdr: "SIGNED_XDR" },
      execute: async () => RESPONSE,
    });
    expect(retry).toEqual({ kind: "in-progress" });
  });

  it("fails closed when claim persistence is ambiguous", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async claim(key, record, ttlMs) {
        await memory.claim(key, record, ttlMs);
        throw new Error("claim response lost");
      },
    };
    const execute = vi.fn(async () => RESPONSE);

    const result = await runNonTransactionIdempotently({
      store,
      key: "submit:ambiguous-claim",
      validatedRequest: { xdr: "SIGNED_XDR" },
      execute,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("confirms an ambiguous finalize only after reading its persisted response", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async finalize(key, ownerToken, expectedRevision, record, ttlMs) {
        await memory.finalize(
          key,
          ownerToken,
          expectedRevision,
          record,
          ttlMs
        );
        throw new Error("finalize response lost");
      },
    };

    const result = await runNonTransactionIdempotently({
      store,
      key: "deposit:ambiguous-finalize",
      validatedRequest: { amount: "10" },
      execute: async () => RESPONSE,
    });

    expect(result).toEqual({ kind: "executed", response: RESPONSE });
  });

  it("does not report success when finalization and its verification read fail", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async finalize() {
        throw new Error("finalize unavailable");
      },
      async get() {
        throw new Error("read unavailable");
      },
    };

    const result = await runNonTransactionIdempotently({
      store,
      key: "withdraw:unconfirmed-finalize",
      validatedRequest: { shares: "2" },
      execute: async () => RESPONSE,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("does not report success after lease renewal cannot be confirmed", async () => {
    const memory = createInMemoryIdempotencyStore();
    const finalize = vi.spyOn(memory, "finalize");
    const store: IdempotencyStore = {
      ...memory,
      async renew() {
        throw new Error("renewal response lost");
      },
    };

    const result = await runNonTransactionIdempotently({
      store,
      key: "submit:renewal-failure",
      validatedRequest: { xdr: "SIGNED_XDR" },
      leaseTtlMs: 100,
      renewalIntervalMs: 5,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return RESPONSE;
      },
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("refuses to finalize a record after its lease revision has changed", async () => {
    const store = createInMemoryIdempotencyStore();
    const requestHash = hashValidatedRequest({ xdr: "SIGNED_XDR" });
    const processing: IdempotencyRecord = {
      state: "processing",
      requestHash,
      ownerToken: "owner-one",
      createdAtMs: 10,
      updatedAtMs: 10,
    };
    const claim = await store.claim("submit:owned", processing, 100);
    expect(claim).not.toBeNull();
    const renewed = await store.renew(
      "submit:owned",
      "owner-one",
      claim!.revision,
      11,
      200
    );
    expect(renewed).not.toBeNull();

    const staleFinalize = await store.finalize(
      "submit:owned",
      "owner-one",
      claim!.revision,
      {
        state: "completed",
        requestHash,
        ownerToken: "owner-one",
        response: RESPONSE,
        completedAtMs: 11,
      },
      1_000
    );
    const ownerFinalize = await store.finalize(
      "submit:owned",
      "owner-one",
      renewed!.revision,
      {
        state: "completed",
        requestHash,
        ownerToken: "owner-one",
        response: RESPONSE,
        completedAtMs: 12,
      },
      1_000
    );

    expect(staleFinalize).toBeNull();
    expect(ownerFinalize?.record.state).toBe("completed");
  });

  it("does not renew a lease for a different owner", async () => {
    const store = createInMemoryIdempotencyStore();
    const claim = await store.claim(
      "submit:renew-owner",
      {
        state: "processing",
        requestHash: "request-hash",
        ownerToken: "owner-one",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      100
    );

    expect(
      await store.renew(
        "submit:renew-owner",
        "owner-two",
        claim!.revision,
        2,
        200
      )
    ).toBeNull();
  });
});

describe("durable uncertain submissions", () => {
  it("persists the transaction identity before returning permission to submit", async () => {
    const store = createInMemoryIdempotencyStore();
    const result = await beginIdempotentSubmission({
      store,
      key: "submit:client-key",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
      now: () => 1_000,
    });

    if (result.kind !== "ready") {
      throw new Error(`Expected ready submission claim, got ${result.kind}`);
    }
    expect(result.record).toMatchObject({
      state: "outcome_unknown",
      requestHash: hashValidatedRequest({ xdr: SUBMISSION.signedXdr }),
      transactionHash: SUBMISSION.transactionHash,
      signedXdr: SUBMISSION.signedXdr,
      maxTime: "2000",
      maxLedger: null,
    });
    expect((await store.get("submit:client-key"))?.record.state).toBe(
      "outcome_unknown"
    );
  });

  it("rejects a submission identity without a finite upper validity bound", async () => {
    const store = createInMemoryIdempotencyStore();
    await expect(beginIdempotentSubmission({
      store,
      key: "submit:unbounded",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: { ...SUBMISSION, maxTime: null, maxLedger: null },
    })).rejects.toThrow(/finite upper validity bound/);
    expect(await store.get("submit:unbounded")).toBeNull();
  });

  it("never lets an ordinary lease expiry reclaim an unknown outcome", async () => {
    let now = 1_000;
    const store = createInMemoryIdempotencyStore({ now: () => now });
    const first = await beginIdempotentSubmission({
      store,
      key: "submit:expiry",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
      leaseTtlMs: 25,
      now: () => now,
    });
    now += 60_000;

    const retry = await beginIdempotentSubmission({
      store,
      key: "submit:expiry",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
      leaseTtlMs: 25,
      now: () => now,
    });

    expect(first.kind).toBe("ready");
    expect(retry.kind).toBe("outcome-unknown");
  });

  it("serializes concurrent submission claims to one ready owner", async () => {
    const store = createInMemoryIdempotencyStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        beginIdempotentSubmission({
          store,
          key: "submit:race",
          validatedRequest: { xdr: SUBMISSION.signedXdr },
          submission: SUBMISSION,
        })
      )
    );

    expect(results.filter((result) => result.kind === "ready")).toHaveLength(1);
    expect(
      results.filter((result) => result.kind === "outcome-unknown")
    ).toHaveLength(7);
  });

  it("returns a replay for a completed key and conflicts on a different body", async () => {
    const store = createInMemoryIdempotencyStore();
    await beginIdempotentSubmission({
      store,
      key: "submit:replay",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });
    await reconcileIdempotentSubmission({
      store,
      key: "submit:replay",
      observation: {
        kind: "SUCCESS",
        transactionHash: SUBMISSION.transactionHash,
        response: RESPONSE,
      },
    });

    const replay = await beginIdempotentSubmission({
      store,
      key: "submit:replay",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });
    const conflict = await beginIdempotentSubmission({
      store,
      key: "submit:replay",
      validatedRequest: { xdr: "DIFFERENT_XDR" },
      submission: { ...SUBMISSION, signedXdr: "DIFFERENT_XDR" },
    });

    expect(replay).toEqual({ kind: "replayed", response: RESPONSE });
    expect(conflict).toEqual({ kind: "conflict" });
  });

  it.each(["SUCCESS", "FAILED"] as const)(
    "resolves only an authoritative %s outcome",
    async (kind) => {
      const store = createInMemoryIdempotencyStore();
      await beginIdempotentSubmission({
        store,
        key: `submit:${kind}`,
        validatedRequest: { xdr: SUBMISSION.signedXdr },
        submission: SUBMISSION,
      });

      const resolved = await reconcileIdempotentSubmission({
        store,
        key: `submit:${kind}`,
        observation: {
          kind,
          transactionHash: SUBMISSION.transactionHash,
          response: RESPONSE,
        },
      });

      expect(resolved).toEqual({
        kind: "completed",
        resolution: kind,
        response: RESPONSE,
      });
    }
  );

  it("keeps NOT_FOUND unknown while either validity bound is still open", async () => {
    const store = createInMemoryIdempotencyStore();
    await beginIdempotentSubmission({
      store,
      key: "submit:valid-not-found",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: { ...SUBMISSION, maxLedger: 120 },
    });

    const result = await reconcileIdempotentSubmission({
      store,
      key: "submit:valid-not-found",
      observation: {
        kind: "NOT_FOUND",
        transactionHash: SUBMISSION.transactionHash,
        latestLedger: 110,
        latestLedgerCloseTime: "2100",
        oldestLedger: 90,
        expiredResponse: { status: 410, body: { error: "expired" } },
      },
    });

    expect(result.kind).toBe("outcome-unknown");
    expect((await store.get("submit:valid-not-found"))?.record.state).toBe(
      "outcome_unknown"
    );
  });

  it.each(["RPC_TIMEOUT", "TRY_AGAIN_LATER", "REDIS_UNCERTAIN"] as const)(
    "preserves unknown state after %s",
    async (kind) => {
      const store = createInMemoryIdempotencyStore();
      await beginIdempotentSubmission({
        store,
        key: `submit:${kind}`,
        validatedRequest: { xdr: SUBMISSION.signedXdr },
        submission: SUBMISSION,
      });

      const result = await reconcileIdempotentSubmission({
        store,
        key: `submit:${kind}`,
        observation: { kind },
      });

      expect(result.kind).toBe("outcome-unknown");
    }
  );

  it("keeps an expired NOT_FOUND unknown when RPC history no longer covers the submission", async () => {
    const store = createInMemoryIdempotencyStore();
    await beginIdempotentSubmission({
      store,
      key: "submit:history-gap",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });

    const result = await reconcileIdempotentSubmission({
      store,
      key: "submit:history-gap",
      observation: {
        kind: "NOT_FOUND",
        transactionHash: SUBMISSION.transactionHash,
        latestLedger: 200,
        latestLedgerCloseTime: "3000",
        oldestLedger: 101,
        expiredResponse: { status: 410, body: { error: "expired" } },
      },
    });

    expect(result.kind).toBe("outcome-unknown");
  });

  it("completes an expired NOT_FOUND only when retained history covers the possible submission", async () => {
    const store = createInMemoryIdempotencyStore();
    await beginIdempotentSubmission({
      store,
      key: "submit:expired-covered",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });

    const result = await reconcileIdempotentSubmission({
      store,
      key: "submit:expired-covered",
      observation: {
        kind: "NOT_FOUND",
        transactionHash: SUBMISSION.transactionHash,
        latestLedger: 200,
        latestLedgerCloseTime: "3000",
        oldestLedger: 99,
        expiredResponse: { status: 410, body: { error: "expired" } },
      },
    });

    expect(result).toEqual({
      kind: "completed",
      resolution: "EXPIRED",
      response: { status: 410, body: { error: "expired" } },
    });
  });

  it("confirms an ambiguous persistence write by reading the durable unknown record", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async markOutcomeUnknown(key, ownerToken, revision, record) {
        await memory.markOutcomeUnknown(key, ownerToken, revision, record);
        throw new Error("write response lost");
      },
    };

    const result = await beginIdempotentSubmission({
      store,
      key: "submit:ambiguous-mark",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });

    expect(result.kind).toBe("ready");
  });

  it("does not submit or resolve when persistence cannot be confirmed", async () => {
    const memory = createInMemoryIdempotencyStore();
    const store: IdempotencyStore = {
      ...memory,
      async markOutcomeUnknown() {
        throw new Error("write failed");
      },
      async get() {
        throw new Error("read failed");
      },
    };

    const result = await beginIdempotentSubmission({
      store,
      key: "submit:storage-down",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("rejects stale-owner reconciliation and preserves the unknown record", async () => {
    const store = createInMemoryIdempotencyStore();
    await beginIdempotentSubmission({
      store,
      key: "submit:wrong-owner",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });
    const current = await store.get("submit:wrong-owner");

    const changed = await store.resolveOutcomeUnknown(
      "submit:wrong-owner",
      "not-the-owner",
      current!.revision,
      {
        state: "completed",
        requestHash: current!.record.requestHash,
        ownerToken: "not-the-owner",
        resolution: "SUCCESS",
        response: RESPONSE,
        completedAtMs: 2_000,
      },
      DEFAULT_IDEMPOTENCY_RESULT_TTL_MS
    );

    expect(changed).toBeNull();
    expect((await store.get("submit:wrong-owner"))?.record.state).toBe(
      "outcome_unknown"
    );
  });

  it.each(["SUCCESS", "FAILED", "NOT_FOUND"] as const)(
    "rejects a mismatched %s observation without changing the unknown record",
    async (kind) => {
      const store = createInMemoryIdempotencyStore();
      const key = `submit:mismatch:${kind}`;
      await beginIdempotentSubmission({
        store,
        key,
        validatedRequest: { xdr: SUBMISSION.signedXdr },
        submission: SUBMISSION,
      });
      const before = await store.get(key);
      const observation = kind === "NOT_FOUND"
        ? {
            kind,
            transactionHash: "b".repeat(64),
            latestLedger: 200,
            latestLedgerCloseTime: "3000",
            oldestLedger: 99,
            expiredResponse: RESPONSE,
          }
        : { kind, transactionHash: "b".repeat(64), response: RESPONSE };

      const result = await reconcileIdempotentSubmission({
        store,
        key,
        observation,
      });

      expect(result).toEqual({ kind: "observation-mismatch" });
      expect(await store.get(key)).toEqual(before);
    }
  );

  it("requires latest-ledger progress through the submission-start ledger", async () => {
    const store = createInMemoryIdempotencyStore();
    await beginIdempotentSubmission({
      store,
      key: "submit:ledger-not-progressed",
      validatedRequest: { xdr: SUBMISSION.signedXdr },
      submission: SUBMISSION,
    });

    const result = await reconcileIdempotentSubmission({
      store,
      key: "submit:ledger-not-progressed",
      observation: {
        kind: "NOT_FOUND",
        transactionHash: SUBMISSION.transactionHash,
        latestLedger: 90,
        latestLedgerCloseTime: "3000",
        oldestLedger: 80,
        expiredResponse: RESPONSE,
      },
    });

    expect(result.kind).toBe("outcome-unknown");
  });
});
