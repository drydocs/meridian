import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_MAX_DAYS,
  SNAPSHOT_MAX_PER_USER,
  SNAPSHOT_MAX_TRACKED_PER_RUN,
  SNAPSHOT_MIN_INTERVAL_MS,
  buildPositionSnapshot,
  createInMemoryPositionSnapshotStore,
  createUpstashPositionSnapshotStore,
  getPositionHistory,
  loadPositionSnapshotStore,
  recordPositionSnapshot,
  runPositionSnapshotKeeper,
  snapshotKey,
  trackedUsersKey,
  type PositionSnapshotStore,
} from "./position-snapshots";
import type { KeeperLogger } from "./keeper-retry";
import type { PositionInfo } from "./positions";

function logger(): KeeperLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const DAY = 24 * 60 * 60_000;
const NETWORK = "testnet";
const USER = "GUSER";

function pos(deposited: number, earned: number): PositionInfo[] {
  return [
    {
      vaultId: "meridian-usdc",
      shares: 1,
      deposited,
      earned,
      entryTime: 0,
    },
  ];
}

describe("retention window", () => {
  it("keeps enough snapshots to cover the whole history window", () => {
    expect(
      SNAPSHOT_MAX_PER_USER * SNAPSHOT_MIN_INTERVAL_MS
    ).toBeGreaterThanOrEqual(HISTORY_MAX_DAYS * DAY);
  });
});

describe("buildPositionSnapshot", () => {
  it("totals value and earned and tags each vault with its protocol", () => {
    const snap = buildPositionSnapshot(
      [
        ...pos(100, 5),
        {
          vaultId: "blend-usdc-fixed",
          shares: 1,
          deposited: 50,
          earned: 2,
          entryTime: 0,
        },
        {
          vaultId: "not-a-vault",
          shares: 1,
          deposited: 1,
          earned: 0,
          entryTime: 0,
        },
      ],
      42
    );
    expect(snap.timestamp).toBe(42);
    expect(snap.totalValue).toBe(151);
    expect(snap.totalEarned).toBe(7);
    expect(snap.vaults.map((v) => v.protocol)).toEqual([
      "meridian",
      "blend",
      "unknown",
    ]);
  });

  it("produces a zero snapshot for an empty position list", () => {
    expect(buildPositionSnapshot([], 1)).toEqual({
      timestamp: 1,
      totalValue: 0,
      totalEarned: 0,
      vaults: [],
    });
  });
});

describe("recordPositionSnapshot", () => {
  it("writes a snapshot and tracks the user", async () => {
    const store = createInMemoryPositionSnapshotStore();
    const wrote = await recordPositionSnapshot(
      store,
      USER,
      NETWORK,
      pos(10, 1),
      logger(),
      { now: 1_000 }
    );
    expect(wrote).toBe(true);
    expect(await store.listTracked(trackedUsersKey(NETWORK), 10)).toEqual([
      USER,
    ]);
    const history = await getPositionHistory(store, USER, NETWORK, 1, 1_000);
    expect(history).toHaveLength(1);
    expect(history[0]?.totalValue).toBe(10);
  });

  it("skips a second snapshot inside the throttle window", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await recordPositionSnapshot(store, USER, NETWORK, pos(10, 1), logger(), {
      now: 1_000,
    });
    const wrote = await recordPositionSnapshot(
      store,
      USER,
      NETWORK,
      pos(11, 2),
      logger(),
      { now: 1_000 + SNAPSHOT_MIN_INTERVAL_MS - 1 }
    );
    expect(wrote).toBe(false);
    expect(await store.range(snapshotKey(USER, NETWORK), 0)).toHaveLength(1);
  });

  it("writes again once the throttle window has passed", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await recordPositionSnapshot(store, USER, NETWORK, pos(10, 1), logger(), {
      now: 1_000,
    });
    const wrote = await recordPositionSnapshot(
      store,
      USER,
      NETWORK,
      pos(11, 2),
      logger(),
      { now: 1_000 + SNAPSHOT_MIN_INTERVAL_MS }
    );
    expect(wrote).toBe(true);
    expect(await store.range(snapshotKey(USER, NETWORK), 0)).toHaveLength(2);
  });

  it("never throws when the store fails", async () => {
    const store: PositionSnapshotStore = {
      ...createInMemoryPositionSnapshotStore(),
      latest: async () => {
        throw new Error("redis down");
      },
    };
    const log = logger();
    await expect(
      recordPositionSnapshot(store, USER, NETWORK, pos(1, 0), log)
    ).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe("getPositionHistory", () => {
  it("returns only snapshots inside the window, oldest first", async () => {
    const store = createInMemoryPositionSnapshotStore();
    const key = snapshotKey(USER, NETWORK);
    const now = 100 * DAY;
    for (const t of [now - 40 * DAY, now - 5 * DAY, now - 10 * DAY]) {
      await store.append(key, buildPositionSnapshot(pos(1, 0), t), 100);
    }
    const history = await getPositionHistory(store, USER, NETWORK, 30, now);
    expect(history.map((s) => s.timestamp)).toEqual([
      now - 10 * DAY,
      now - 5 * DAY,
    ]);
  });

  it("clamps days to the retention window", async () => {
    const store = createInMemoryPositionSnapshotStore();
    const key = snapshotKey(USER, NETWORK);
    const now = 500 * DAY;
    await store.append(
      key,
      buildPositionSnapshot(pos(1, 0), now - 91 * DAY),
      100
    );
    await store.append(
      key,
      buildPositionSnapshot(pos(1, 0), now - 89 * DAY),
      100
    );
    const history = await getPositionHistory(store, USER, NETWORK, 9999, now);
    expect(history).toHaveLength(1);
  });

  it("keeps histories per user and per network separate", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await recordPositionSnapshot(store, "A", NETWORK, pos(1, 0), logger(), {
      now: 1,
    });
    expect(await getPositionHistory(store, "B", NETWORK, 1, 2)).toEqual([]);
    expect(await getPositionHistory(store, "A", "mainnet", 1, 2)).toEqual([]);
  });
});

describe("in-memory store retention", () => {
  it("trims to the newest maxEntries", async () => {
    const store = createInMemoryPositionSnapshotStore();
    for (let t = 1; t <= 5; t++) {
      await store.append("k", buildPositionSnapshot([], t), 3);
    }
    expect((await store.range("k", 0)).map((s) => s.timestamp)).toEqual([
      3, 4, 5,
    ]);
  });
});

describe("runPositionSnapshotKeeper", () => {
  it("snapshots every tracked user and reports counts", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await store.track(trackedUsersKey(NETWORK), "A", 1);
    await store.track(trackedUsersKey(NETWORK), "B", 2);
    const resolve = vi.fn(async () => pos(10, 1));
    const result = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve,
      logger: logger(),
      now: 5_000,
    });
    expect(result).toMatchObject({
      tracked: 2,
      processed: 2,
      recorded: 2,
      skipped: 0,
      failures: [],
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("skips users snapshotted within the throttle window", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await recordPositionSnapshot(store, "A", NETWORK, pos(1, 0), logger(), {
      now: 1_000,
    });
    const result = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve: async () => pos(1, 0),
      logger: logger(),
      now: 2_000,
    });
    expect(result).toMatchObject({ recorded: 0, skipped: 1 });
  });

  it("records a failing user and continues with the rest", async () => {
    const store = createInMemoryPositionSnapshotStore();
    await store.track(trackedUsersKey(NETWORK), "A", 1);
    await store.track(trackedUsersKey(NETWORK), "B", 2);
    const result = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve: async (pk) => {
        if (pk === "A") throw new Error("rpc down");
        return pos(1, 0);
      },
      logger: logger(),
      now: 1,
    });
    expect(result.recorded).toBe(1);
    expect(result.failures).toEqual([{ publicKey: "A", error: "rpc down" }]);
  });

  it("treats a partial read as a failure and leaves the wallet tracked", async () => {
    const store = createInMemoryPositionSnapshotStore();
    const key = trackedUsersKey(NETWORK);
    await store.track(key, "A", 1);
    const result = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve: async () => null,
      logger: logger(),
      now: 10,
    });
    expect(result.recorded).toBe(0);
    expect(result.failures).toEqual([
      { publicKey: "A", error: "could not read every vault" },
    ]);
    expect(await store.listTracked(key, 10)).toEqual(["A"]);
    expect(await store.range(snapshotKey("A", NETWORK), 0)).toEqual([]);
  });

  it("closes the series and drops a wallet that holds nothing", async () => {
    const store = createInMemoryPositionSnapshotStore();
    const key = trackedUsersKey(NETWORK);
    const now = 1_000 + SNAPSHOT_MIN_INTERVAL_MS;
    await recordPositionSnapshot(store, "A", NETWORK, pos(10, 1), logger(), {
      now: 1_000,
    });
    const result = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve: async () => [],
      logger: logger(),
      now,
    });
    expect(result.skipped).toBe(1);
    expect(await store.listTracked(key, 10)).toEqual([]);
    const history = await getPositionHistory(store, "A", NETWORK, 90, now);
    expect(history.at(-1)?.totalValue).toBe(0);
  });

  it("caps the users processed per run and rotates to the ones left over", async () => {
    const store = createInMemoryPositionSnapshotStore();
    const key = trackedUsersKey(NETWORK);
    const total = SNAPSHOT_MAX_TRACKED_PER_RUN + 5;
    for (let i = 0; i < total; i++) {
      await store.track(key, `U${i}`, 10_000 + i);
    }
    const first = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve: async () => pos(1, 0),
      logger: logger(),
      now: 10_000 + total,
    });
    expect(first.tracked).toBe(total);
    expect(first.processed).toBe(SNAPSHOT_MAX_TRACKED_PER_RUN);

    const processed: string[] = [];
    const second = await runPositionSnapshotKeeper({
      store,
      network: NETWORK,
      resolve: async (pk) => {
        processed.push(pk);
        return pos(1, 0);
      },
      logger: logger(),
      now: 10_000 + total + 1,
    });
    expect(second.processed).toBe(SNAPSHOT_MAX_TRACKED_PER_RUN);
    // The five left over are seen longest ago, so the second run reaches them
    // before revisiting anyone the first run already snapshotted.
    expect(processed.slice(0, 5)).toEqual([
      "U200",
      "U201",
      "U202",
      "U203",
      "U204",
    ]);
  });
});

describe("createUpstashPositionSnapshotStore", () => {
  function fakeUpstash(results: unknown[]) {
    const calls: unknown[][] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ result: results.shift() ?? null }));
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const snap = buildPositionSnapshot(pos(10, 1), 7);

  it("appends with ZADD scored by time, then trims with ZREMRANGEBYRANK", async () => {
    const { calls, fetchImpl } = fakeUpstash([1, 0]);
    const store = createUpstashPositionSnapshotStore({
      url: "https://r.example/",
      token: "t",
      fetchImpl,
    });
    await store.append("k", snap, 100);
    expect(calls[0]).toEqual(["ZADD", "k", 7, JSON.stringify(snap)]);
    expect(calls[1]).toEqual(["ZREMRANGEBYRANK", "k", 0, -101]);
  });

  it("reads the latest and a range, ignoring malformed members", async () => {
    const { calls, fetchImpl } = fakeUpstash([
      [JSON.stringify(snap)],
      [JSON.stringify(snap), "not-json", JSON.stringify({ nope: 1 })],
    ]);
    const store = createUpstashPositionSnapshotStore({
      url: "https://r.example",
      token: "t",
      fetchImpl,
    });
    expect(await store.latest("k")).toEqual(snap);
    expect(await store.range("k", 5)).toEqual([snap]);
    expect(calls[0]).toEqual(["ZREVRANGE", "k", 0, 0]);
    expect(calls[1]).toEqual(["ZRANGEBYSCORE", "k", 5, "+inf"]);
  });

  it("returns null/empty when nothing is stored", async () => {
    const { fetchImpl } = fakeUpstash([[], [], null]);
    const store = createUpstashPositionSnapshotStore({
      url: "https://r.example",
      token: "t",
      fetchImpl,
    });
    expect(await store.latest("k")).toBeNull();
    expect(await store.range("k", 0)).toEqual([]);
    expect(await store.listTracked("s", 10)).toEqual([]);
  });

  it("tracks users with ZADD and lists the longest-seen first", async () => {
    const { calls, fetchImpl } = fakeUpstash([1, ["A", "B"], 2, 1]);
    const store = createUpstashPositionSnapshotStore({
      url: "https://r.example",
      token: "t",
      fetchImpl,
    });
    await store.track("s", "A", 5);
    expect(await store.listTracked("s", 2)).toEqual(["A", "B"]);
    expect(await store.countTracked("s")).toBe(2);
    await store.untrack("s", "A");
    expect(calls[0]).toEqual(["ZADD", "s", 5, "A"]);
    expect(calls[1]).toEqual(["ZRANGE", "s", 0, 1]);
    expect(calls[2]).toEqual(["ZCARD", "s"]);
    expect(calls[3]).toEqual(["ZREM", "s", "A"]);
  });

  it("surfaces HTTP and Redis errors", async () => {
    const httpFail = vi.fn(
      async () => new Response("no", { status: 500 })
    ) as unknown as typeof fetch;
    const redisFail = vi.fn(
      async () => new Response(JSON.stringify({ error: "WRONGTYPE" }))
    ) as unknown as typeof fetch;
    await expect(
      createUpstashPositionSnapshotStore({
        url: "https://r.example",
        token: "t",
        fetchImpl: httpFail,
      }).latest("k")
    ).rejects.toThrow("HTTP 500");
    await expect(
      createUpstashPositionSnapshotStore({
        url: "https://r.example",
        token: "t",
        fetchImpl: redisFail,
      }).latest("k")
    ).rejects.toThrow("WRONGTYPE");
  });
});

describe("loadPositionSnapshotStore", () => {
  it("uses Upstash when both credentials are set", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ result: [] }))
    ) as unknown as typeof fetch;
    const store = loadPositionSnapshotStore(
      {
        UPSTASH_REDIS_REST_URL: "https://r.example",
        UPSTASH_REDIS_REST_TOKEN: "t",
      },
      { logger: logger(), fetchImpl }
    );
    await store.latest("k");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back to in-memory, warning only on a deployed environment", () => {
    const local = logger();
    loadPositionSnapshotStore({}, { logger: local });
    expect(local.info).toHaveBeenCalledOnce();
    expect(local.warn).not.toHaveBeenCalled();

    const deployed = logger();
    loadPositionSnapshotStore(
      { VERCEL_ENV: "production" },
      { logger: deployed }
    );
    expect(deployed.warn).toHaveBeenCalledOnce();
  });
});
