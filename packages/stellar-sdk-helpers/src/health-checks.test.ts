import { describe, expect, it, vi } from "vitest";
import {
  checkPositionSnapshotStoreHealth,
  checkSorobanRpcHealth,
  checkUpstashRedisHealth,
} from "./health-checks";
import { getRpcServer } from "./internal";
import {
  createInMemoryPositionSnapshotStore,
  trackedUsersKey,
} from "./position-snapshots";

vi.mock("./internal", () => ({
  getRpcServer: vi.fn(() => ({
    getLatestLedger: vi.fn(async () => ({ sequence: 123 })),
  })),
}));

describe("health checks", () => {
  it("returns the latest Soroban ledger", async () => {
    await expect(checkSorobanRpcHealth("https://rpc.example")).resolves.toEqual(
      { latestLedger: 123 }
    );
  });

  it.each([
    ["missing sequence", {}],
    ["non-numeric sequence", { sequence: "123" }],
    ["NaN sequence", { sequence: Number.NaN }],
    ["infinite sequence", { sequence: Number.POSITIVE_INFINITY }],
  ])(
    "rejects an invalid Soroban RPC response with %s",
    async (_case, latest) => {
      vi.mocked(getRpcServer).mockReturnValue({
        getLatestLedger: vi.fn().mockResolvedValue(latest),
      } as never);

      await expect(
        checkSorobanRpcHealth("https://rpc.example")
      ).rejects.toThrow(/invalid latest ledger/);
    }
  );

  it("requires Upstash PING to return PONG", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ result: "PONG" })
    ) as unknown as typeof fetch;
    await expect(
      checkUpstashRedisHealth({
        url: "https://redis.example",
        token: "token",
        fetchImpl,
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({ body: '["PING"]' })
    );
  });

  it("rejects a non-PONG Upstash response", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ result: "OK" })
    ) as unknown as typeof fetch;
    await expect(
      checkUpstashRedisHealth({
        url: "https://redis.example",
        token: "token",
        fetchImpl,
      })
    ).rejects.toThrow(/invalid PING response/);
  });

  it.each([
    ["empty URL", { url: "", token: "token" }],
    ["empty token", { url: "https://redis.example", token: "" }],
    ["blank URL", { url: "   ", token: "token" }],
    ["blank token", { url: "https://redis.example", token: "   " }],
  ])("rejects Upstash credentials with %s", async (_case, credentials) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      checkUpstashRedisHealth({ ...credentials, fetchImpl } as {
        url: string;
        token: string;
        fetchImpl: typeof fetch;
      })
    ).rejects.toThrow(/credentials are not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("times out a hung Upstash PING", async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;
    await expect(
      checkUpstashRedisHealth({
        url: "https://redis.example",
        token: "token",
        fetchImpl,
        timeoutMs: 10,
      })
    ).rejects.toThrow(/timed out/);
  });

  it("treats an empty snapshot registry as healthy", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await expect(
      checkPositionSnapshotStoreHealth(store, "testnet")
    ).resolves.toEqual({ trackedUsers: 0 });
  });

  it("reports the count from the snapshot registry", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await store.track(trackedUsersKey("testnet"), "wallet", Date.now());
    await expect(
      checkPositionSnapshotStoreHealth(store, "testnet")
    ).resolves.toEqual({ trackedUsers: 1 });
  });

  it("propagates a snapshot registry read failure", async () => {
    const countTracked = vi.fn(async (_key: string): Promise<number> => {
      throw new Error("storage unavailable");
    });
    const store = { countTracked };

    await expect(
      checkPositionSnapshotStoreHealth(store, "testnet")
    ).rejects.toThrow("storage unavailable");
    expect(countTracked).toHaveBeenCalledWith(trackedUsersKey("testnet"));
  });

  it("bounds snapshot registry reads", async () => {
    const store = {
      countTracked: vi.fn(() => new Promise<number>(() => {})),
    } as never;
    await expect(
      checkPositionSnapshotStoreHealth(store, "testnet", 10)
    ).rejects.toThrow(/timed out/);
  });
});
