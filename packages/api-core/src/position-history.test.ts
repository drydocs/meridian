import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  HISTORY_DEFAULT_DAYS: 30,
  HISTORY_MAX_DAYS: 90,
  loadPositionSnapshotStore: vi.fn(() => ({})),
  getPositionHistory: vi.fn(async () => []),
}));

import {
  bucketPositionSnapshots,
  handleGetPositionHistory,
} from "./position-history";
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

  it("returns every stored snapshot, unpaginated, when no pagination parameter is sent", async () => {
    const hour = 60 * 60 * 1000;
    const snapshots = Array.from({ length: 1500 }, (_, i) => ({
      timestamp: (i + 1) * hour,
      totalValue: i,
      totalEarned: 0,
      vaults: [],
    }));
    vi.mocked(getPositionHistory).mockResolvedValueOnce(snapshots);

    const result = await handleGetPositionHistory(PUBKEY, "90");

    expect(result.body).toEqual({ publicKey: PUBKEY, days: 90, snapshots });
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

  it("rejects invalid resolution, limit, and cursor parameters", async () => {
    expect((await handleGetPositionHistory(PUBKEY, "30", "week")).status).toBe(
      400
    );
    expect(
      (await handleGetPositionHistory(PUBKEY, "30", "hour", "0")).status
    ).toBe(400);
    expect(
      (await handleGetPositionHistory(PUBKEY, "30", "hour", "1001")).status
    ).toBe(400);
    expect(
      (await handleGetPositionHistory(PUBKEY, "30", "hour", "10", "bad")).status
    ).toBe(400);
  });

  it("returns 503 when the store read fails", async () => {
    const err = new Error("redis down");
    vi.mocked(getPositionHistory).mockRejectedValueOnce(err);
    const result = await handleGetPositionHistory(PUBKEY);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Failed to read position history" });
    expect(result.error).toBe(err);
  });

  it("returns bounded pages with a stable cursor", async () => {
    const hour = 60 * 60 * 1000;
    vi.mocked(getPositionHistory).mockResolvedValue([
      { timestamp: hour, totalValue: 1, totalEarned: 0, vaults: [] },
      { timestamp: 2 * hour, totalValue: 2, totalEarned: 1, vaults: [] },
      { timestamp: 3 * hour, totalValue: 3, totalEarned: 2, vaults: [] },
    ]);

    const first = await handleGetPositionHistory(PUBKEY, "30", "hour", "1");
    expect(first.body).toMatchObject({
      truncated: true,
      nextCursor: String(hour),
    });

    const second = await handleGetPositionHistory(
      PUBKEY,
      "30",
      "hour",
      "1",
      String(hour)
    );
    expect(second.body).toMatchObject({
      truncated: true,
      nextCursor: String(2 * hour),
    });
  });
});

describe("bucketPositionSnapshots", () => {
  it("keeps the latest value and the min and max in hour buckets", () => {
    const hour = 60 * 60 * 1000;
    const snapshots = [
      { timestamp: hour + 10, totalValue: 10, totalEarned: 1, vaults: [] },
      { timestamp: hour + 20, totalValue: 4, totalEarned: 0.5, vaults: [] },
      { timestamp: hour + 30, totalValue: 12, totalEarned: 2, vaults: [] },
    ];

    const buckets = bucketPositionSnapshots(snapshots, "hour");

    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.totalValue).toBe(12);
    expect(buckets[0]).not.toHaveProperty("first");
    expect(buckets[0]).not.toHaveProperty("last");
    expect(buckets[0]!.min.totalValue).toBe(4);
    expect(buckets[0]!.max.totalValue).toBe(12);
  });

  it("creates stable UTC day buckets", () => {
    const day = 24 * 60 * 60 * 1000;
    const buckets = bucketPositionSnapshots(
      [
        { timestamp: day + 1, totalValue: 1, totalEarned: 0, vaults: [] },
        { timestamp: day + 100, totalValue: 2, totalEarned: 1, vaults: [] },
        { timestamp: 2 * day + 1, totalValue: 3, totalEarned: 2, vaults: [] },
      ],
      "day"
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[0]!.timestamp).toBe(day);
  });
});
