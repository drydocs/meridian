import { describe, expect, it, vi } from "vitest";

import {
  KEEPER_SCHEDULE_MS,
  createInMemoryKeeperHeartbeatStore,
  createUpstashKeeperHeartbeatStore,
  getKeeperHeartbeat,
  heartbeatKey,
  isKeeperHealthy,
  loadKeeperHeartbeatStore,
  recordKeeperHeartbeat,
  type KeeperHeartbeatStore,
} from "./keeper-heartbeat";
import type { KeeperLogger } from "./keeper-retry";

function logger(): KeeperLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("heartbeatKey", () => {
  it("namespaces by keeper and network", () => {
    expect(heartbeatKey("accrual", "testnet")).toBe(
      "meridian:keeper:heartbeat:accrual:testnet"
    );
    expect(heartbeatKey("migration", "mainnet")).toBe(
      "meridian:keeper:heartbeat:migration:mainnet"
    );
  });
});

describe("isKeeperHealthy", () => {
  it("is unhealthy when no success has ever been recorded", () => {
    expect(isKeeperHealthy("accrual", null)).toBe(false);
  });

  it("is healthy within the schedule interval", () => {
    const now = 1_000_000;
    expect(
      isKeeperHealthy("accrual", now - KEEPER_SCHEDULE_MS.accrual / 2, now)
    ).toBe(true);
  });

  it("stays healthy through one missed tick (2x grace) but not two", () => {
    const now = 10_000_000;
    const interval = KEEPER_SCHEDULE_MS.migration;
    expect(isKeeperHealthy("migration", now - interval * 1.9, now)).toBe(true);
    expect(isKeeperHealthy("migration", now - interval * 2.1, now)).toBe(false);
  });
});

describe("recordKeeperHeartbeat / getKeeperHeartbeat", () => {
  it("round-trips a recorded success time through an in-memory store", async () => {
    const store = createInMemoryKeeperHeartbeatStore();
    await recordKeeperHeartbeat(store, "accrual", "testnet", logger(), 123);
    expect(
      await getKeeperHeartbeat(store, "accrual", "testnet", logger())
    ).toBe(123);
  });

  it("keeps accrual and migration heartbeats independent", async () => {
    const store = createInMemoryKeeperHeartbeatStore();
    await recordKeeperHeartbeat(store, "accrual", "testnet", logger(), 1);
    await recordKeeperHeartbeat(store, "migration", "testnet", logger(), 2);
    expect(
      await getKeeperHeartbeat(store, "accrual", "testnet", logger())
    ).toBe(1);
    expect(
      await getKeeperHeartbeat(store, "migration", "testnet", logger())
    ).toBe(2);
  });

  it("returns null and does not throw when the store read fails", async () => {
    const failing: KeeperHeartbeatStore = {
      get: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
      set: vi.fn(),
    };
    const log = logger();
    const result = await getKeeperHeartbeat(failing, "accrual", "testnet", log);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("does not throw when the store write fails", async () => {
    const failing: KeeperHeartbeatStore = {
      get: vi.fn(),
      set: vi.fn(async () => {
        throw new Error("store unavailable");
      }),
    };
    const log = logger();
    await expect(
      recordKeeperHeartbeat(failing, "accrual", "testnet", log, 1)
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("createUpstashKeeperHeartbeatStore", () => {
  function fetchMock(response: unknown) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => response,
    })) as unknown as typeof fetch;
  }

  it("reads a stored timestamp back as a number", async () => {
    const fetchImpl = fetchMock({ result: "12345" });
    const store = createUpstashKeeperHeartbeatStore({
      url: "https://redis.example/",
      token: "tok",
      fetchImpl,
    });
    expect(await store.get("k")).toBe(12345);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["GET", "k"]),
      })
    );
  });

  it("returns null when nothing is stored", async () => {
    const store = createUpstashKeeperHeartbeatStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl: fetchMock({ result: null }),
    });
    expect(await store.get("k")).toBeNull();
  });

  it("writes with an unconditional SET, no NX and no expiry", async () => {
    const fetchImpl = fetchMock({ result: "OK" });
    const store = createUpstashKeeperHeartbeatStore({
      url: "https://redis.example",
      token: "tok",
      fetchImpl,
    });
    await store.set("k", 999);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://redis.example",
      expect.objectContaining({
        body: JSON.stringify(["SET", "k", "999"]),
      })
    );
  });
});

describe("loadKeeperHeartbeatStore", () => {
  const credentialPairs = [
    {
      name: "unprefixed",
      urlKey: "UPSTASH_REDIS_REST_URL",
      tokenKey: "UPSTASH_REDIS_REST_TOKEN",
    },
    {
      name: "store-prefixed",
      urlKey: "UPSTASH_REDIS_REST_KV_REST_API_URL",
      tokenKey: "UPSTASH_REDIS_REST_KV_REST_API_TOKEN",
    },
  ];

  async function expectUpstash(
    env: Record<string, string | undefined>,
    url: string,
    token: string
  ) {
    const log = logger();
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ result: null }))
    );
    const store = loadKeeperHeartbeatStore(
      { ...env, VERCEL_ENV: "production" },
      { logger: log, fetchImpl }
    );
    await store.get("k");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["GET", "k"]),
      })
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  }

  async function expectInMemory(env: Record<string, string | undefined>) {
    for (const vercelEnv of [undefined, "production"]) {
      const log = logger();
      const fetchImpl = vi.fn<typeof fetch>();
      const store = loadKeeperHeartbeatStore(
        { ...env, VERCEL_ENV: vercelEnv },
        { logger: log, fetchImpl }
      );
      await store.set("k", 123);
      expect(await store.get("k")).toBe(123);
      expect(fetchImpl).not.toHaveBeenCalled();
      if (vercelEnv) {
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
          store: "in-memory",
          env: vercelEnv,
        });
        expect(log.info).not.toHaveBeenCalled();
      } else {
        expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
          store: "in-memory",
        });
        expect(log.warn).not.toHaveBeenCalled();
      }
    }
  }

  describe.each(credentialPairs)(
    "$name credentials",
    ({ urlKey, tokenKey }) => {
      it("uses Upstash and trims both credentials", async () => {
        await expectUpstash(
          { [urlKey]: "  https://redis.example/  ", [tokenKey]: "  tok  " },
          "https://redis.example",
          "tok"
        );
      });

      it.each([
        ["missing URL", undefined, "tok"],
        ["missing token", "https://redis.example", undefined],
        ["empty URL", "", "tok"],
        ["empty token", "https://redis.example", ""],
        ["whitespace URL", " \t ", "tok"],
        ["whitespace token", "https://redis.example", " \t "],
      ])("falls back to in-memory with %s", async (_name, url, token) => {
        await expectInMemory({ [urlKey]: url, [tokenKey]: token });
      });
    }
  );

  it("prefers unprefixed credentials when both pairs are present", async () => {
    await expectUpstash(
      {
        UPSTASH_REDIS_REST_URL: " https://primary.example/ ",
        UPSTASH_REDIS_REST_TOKEN: " primary-token ",
        UPSTASH_REDIS_REST_KV_REST_API_URL: "https://fallback.example",
        UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "fallback-token",
      },
      "https://primary.example",
      "primary-token"
    );
  });

  it.each([
    ["UPSTASH_REDIS_REST_URL", "https://fallback.example", "primary-token"],
    ["UPSTASH_REDIS_REST_TOKEN", "https://primary.example", "fallback-token"],
  ])(
    "resolves the fallback independently when %s is missing",
    async (key, url, token) => {
      await expectUpstash(
        {
          UPSTASH_REDIS_REST_URL: "https://primary.example",
          UPSTASH_REDIS_REST_TOKEN: "primary-token",
          UPSTASH_REDIS_REST_KV_REST_API_URL: " https://fallback.example/ ",
          UPSTASH_REDIS_REST_KV_REST_API_TOKEN: " fallback-token ",
          [key]: undefined,
        },
        url,
        token
      );
    }
  );

  it.each(["", " \t "])(
    "does not replace blank unprefixed credentials (%j) with the fallback pair",
    async (blank) => {
      for (const key of [
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
      ]) {
        await expectInMemory({
          UPSTASH_REDIS_REST_URL: "https://primary.example",
          UPSTASH_REDIS_REST_TOKEN: "primary-token",
          UPSTASH_REDIS_REST_KV_REST_API_URL: "https://fallback.example",
          UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "fallback-token",
          [key]: blank,
        });
      }
    }
  );

  it("falls back to in-memory when neither pair is configured", async () => {
    await expectInMemory({});
  });
});
