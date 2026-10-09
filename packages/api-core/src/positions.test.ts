import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loadPositionSnapshotStore: vi.fn(() => ({})),
  recordPositionSnapshot: vi.fn(async () => true),
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

import { handleGetPositions } from "./positions";
import {
  loadPositionSnapshotStore,
  recordPositionSnapshot,
  resolvePositions,
} from "@meridian/stellar-sdk-helpers";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

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
  });

  it("returns 503 when the position read throws", async () => {
    const err = new Error("rpc down");
    vi.mocked(resolvePositions).mockRejectedValueOnce(err);
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Failed to read positions" });
    expect(result.error).toBe(err);
  });

  it("records a position snapshot after a successful read", async () => {
    await handleGetPositions(PUBKEY);
    expect(recordPositionSnapshot).toHaveBeenCalledOnce();
    expect(vi.mocked(recordPositionSnapshot).mock.calls[0]?.[1]).toBe(PUBKEY);
  });

  it("does not record a snapshot for a wallet holding nothing", async () => {
    vi.mocked(resolvePositions).mockResolvedValueOnce([]);
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(200);
    expect(recordPositionSnapshot).not.toHaveBeenCalled();
  });

  it("does not record a snapshot when a vault failed to read", async () => {
    vi.mocked(resolvePositions).mockImplementationOnce(
      async (_publicKey, _network, options) => {
        options?.onVaultError?.(new Error("rpc down"));
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
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(200);
    expect(recordPositionSnapshot).not.toHaveBeenCalled();
  });

  it("does not record a snapshot when the read fails", async () => {
    vi.mocked(resolvePositions).mockRejectedValueOnce(new Error("rpc down"));
    await handleGetPositions(PUBKEY);
    expect(recordPositionSnapshot).not.toHaveBeenCalled();
  });

  it("still returns positions when building the snapshot store throws", async () => {
    vi.mocked(loadPositionSnapshotStore).mockImplementationOnce(() => {
      throw new Error("bad store config");
    });
    const result = await handleGetPositions(PUBKEY);
    expect(result.status).toBe(200);
    expect(recordPositionSnapshot).not.toHaveBeenCalled();
  });
});
