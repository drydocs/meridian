import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  HISTORY_DEFAULT_DAYS: 30,
  HISTORY_MAX_DAYS: 90,
  loadPositionSnapshotStore: vi.fn(() => ({})),
  getPositionHistory: vi.fn(async () => []),
}));

import { handleGetPositionHistory } from "./position-history";
import { getPositionHistory } from "@meridian/stellar-sdk-helpers";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => vi.clearAllMocks());

describe("handleGetPositionHistory", () => {
  it("rejects a malformed or missing public key with 400", async () => {
    expect((await handleGetPositionHistory("too-short")).status).toBe(400);
    expect((await handleGetPositionHistory(undefined)).status).toBe(400);
    expect(getPositionHistory).not.toHaveBeenCalled();
  });

  it("defaults to 30 days and returns the snapshots", async () => {
    const snapshots = [
      { timestamp: 1, totalValue: 2, totalEarned: 0, vaults: [] },
    ];
    vi.mocked(getPositionHistory).mockResolvedValueOnce(snapshots);
    const result = await handleGetPositionHistory(PUBKEY);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ publicKey: PUBKEY, days: 30, snapshots });
    expect(vi.mocked(getPositionHistory).mock.calls[0]?.[3]).toBe(30);
  });

  it("caps days at the retention window", async () => {
    const result = await handleGetPositionHistory(PUBKEY, "9999");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ days: 90 });
  });

  it.each(["0", "-1", "1.5", "abc", "", 7])(
    "rejects days=%j with 400",
    async (days) => {
      const result = await handleGetPositionHistory(PUBKEY, days);
      expect(result.status).toBe(400);
      expect(getPositionHistory).not.toHaveBeenCalled();
    }
  );

  it("returns 503 when the store read fails", async () => {
    const err = new Error("redis down");
    vi.mocked(getPositionHistory).mockRejectedValueOnce(err);
    const result = await handleGetPositionHistory(PUBKEY);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Failed to read position history" });
    expect(result.error).toBe(err);
  });
});
