import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loadPositionSnapshotStore: vi.fn(() => ({})),
  recordPositionSnapshot: vi.fn(async () => true),
  getLatestLedgerSequence: vi.fn(async () => 100),
  resolvePositions: vi.fn(async () => [
    {
      vaultId: "blend-usdc-fixed",
      shares: 1,
      deposited: 1,
      earned: 0,
      entryTime: 0,
    },
  ]),
}));

import {
  handleGetPositions,
  matchesPositionEtag,
  resetPositionReadCacheForTesting,
} from "./positions";
import {
  getLatestLedgerSequence,
  loadPositionSnapshotStore,
  recordPositionSnapshot,
  resolvePositions,
} from "@meridian/stellar-sdk-helpers";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  vi.clearAllMocks();
  resetPositionReadCacheForTesting();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_KV_REST_API_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_KV_REST_API_TOKEN", "");
  vi.mocked(getLatestLedgerSequence).mockResolvedValue(100);
});
afterEach(() => vi.unstubAllEnvs());

describe("handleGetPositions", () => {
  it("rejects a malformed public key with 400", async () => {
    const result = await handleGetPositions("too-short");
    expect(result.status).toBe(400);
    expect(resolvePositions).not.toHaveBeenCalled();
  });

  it("rejects a missing public key with 400", async () => {
    const result = await handleGetPositions(undefined);
    expect(result.status).toBe(400);
  });

  it("returns the resolved positions for a valid key", async () => {
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      positions: [
        {
          vaultId: "blend-usdc-fixed",
          shares: 1,
          deposited: 1,
          earned: 0,
          entryTime: 0,
        },
      ],
    });
    expect(resolvePositions).toHaveBeenCalledOnce();
    expect(result.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("returns 503 when the position read throws", async () => {
    const err = new Error("rpc down");
    vi.mocked(resolvePositions).mockRejectedValueOnce(err);
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Failed to read positions" });
    expect(result.error).toBe(err);
  });

  it("does not cache partial results or return an ETag when a vault read fails", async () => {
    vi.mocked(resolvePositions).mockImplementationOnce(
      async (_publicKey, _network, options) => {
        options?.onVaultError?.(new Error("vault RPC down"));
        return [
          {
            vaultId: "blend-usdc-fixed",
            shares: 1,
            deposited: 1,
            earned: 0,
            entryTime: 0,
          },
        ];
      }
    );

    const partial = await handleGetPositions(PUBKEY);
    expect(partial.status).toBe(200);
    expect(partial.etag).toBeUndefined();
    expect(partial.body).toEqual({
      positions: [
        {
          vaultId: "blend-usdc-fixed",
          shares: 1,
          deposited: 1,
          earned: 0,
          entryTime: 0,
        },
      ],
    });

    const complete = await handleGetPositions(PUBKEY);
    expect(resolvePositions).toHaveBeenCalledTimes(2);
    expect(complete.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("does not write a snapshot after a successful public read", async () => {
    await handleGetPositions(PUBKEY);
    expect(recordPositionSnapshot).not.toHaveBeenCalled();
    expect(loadPositionSnapshotStore).not.toHaveBeenCalled();
  });

  it("does not write a snapshot for a wallet holding nothing", async () => {
    vi.mocked(resolvePositions).mockResolvedValueOnce([]);
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(200);
    expect(recordPositionSnapshot).not.toHaveBeenCalled();
  });

  it("uses the position cache for repeated reads in the same ledger", async () => {
    await handleGetPositions(PUBKEY);
    const second = await handleGetPositions(PUBKEY);
    expect(second.status).toBe(200);
    expect(resolvePositions).toHaveBeenCalledOnce();
    expect(getLatestLedgerSequence).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cached position when the latest ledger changes", async () => {
    const first = await handleGetPositions(PUBKEY);
    vi.mocked(getLatestLedgerSequence).mockResolvedValueOnce(101);
    const second = await handleGetPositions(PUBKEY);
    expect(resolvePositions).toHaveBeenCalledTimes(2);
    expect(second.etag).not.toBe(first.etag);
  });

  it("refresh bypasses the position cache", async () => {
    await handleGetPositions(PUBKEY);
    await handleGetPositions(PUBKEY, { refresh: true });
    expect(resolvePositions).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cold reads for the same wallet", async () => {
    let finishRead!: (
      positions: Awaited<ReturnType<typeof resolvePositions>>
    ) => void;
    vi.mocked(resolvePositions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        })
    );
    const first = handleGetPositions(PUBKEY);
    const second = handleGetPositions(PUBKEY);
    await vi.waitFor(() => expect(resolvePositions).toHaveBeenCalledOnce());
    finishRead([
      {
        vaultId: "blend-usdc-fixed",
        shares: 1,
        deposited: 1,
        earned: 0,
        entryTime: 0,
      },
    ]);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.body).toEqual(secondResult.body);
    expect(getLatestLedgerSequence).toHaveBeenCalledOnce();
  });
});

describe("matchesPositionEtag", () => {
  it("supports strong and weak validators and wildcard matches", () => {
    expect(matchesPositionEtag('"abc"', '"abc"')).toBe(true);
    expect(matchesPositionEtag('W/"abc"', '"abc"')).toBe(true);
    expect(matchesPositionEtag('"other", "abc"', '"abc"')).toBe(true);
    expect(matchesPositionEtag(['"other"', '"abc"'], '"abc"')).toBe(true);
    expect(matchesPositionEtag("*", '"abc"')).toBe(true);
    expect(matchesPositionEtag('"other"', '"abc"')).toBe(false);
    expect(matchesPositionEtag(undefined, '"abc"')).toBe(false);
  });
});
