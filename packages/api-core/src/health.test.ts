import { beforeEach, describe, expect, it, vi } from "vitest";

const appNetwork = vi.hoisted(() => ({
  network: "mainnet",
  rpcUrl: "https://mainnet.sorobanrpc.com",
  passphrase: "",
}));

vi.mock("@meridian/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/shared")>();
  return { ...actual, APP_NETWORK: appNetwork };
});

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  checkPositionSnapshotStoreHealth: vi.fn(),
  checkSorobanRpcHealth: vi.fn(),
  checkUpstashRedisHealth: vi.fn(),
  createInMemoryPositionSnapshotStore: vi.fn(),
  createUpstashPositionSnapshotStore: vi.fn(),
  HEALTH_CHECK_TIMEOUT_MS: 1_500,
  trackedUsersKey: vi.fn(),
}));

import {
  clearReadinessCache,
  handleGetLiveness,
  handleGetReadiness,
  READINESS_CACHE_TTL_MS,
  READINESS_NEGATIVE_CACHE_TTL_MS,
  READINESS_TIMEOUT_MS,
} from "./health";
import {
  checkPositionSnapshotStoreHealth,
  checkSorobanRpcHealth,
  checkUpstashRedisHealth,
} from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK, STELLAR_NETWORKS } from "@meridian/shared";

const baseProbes = {
  sorobanRpc: vi.fn(async () => ({ latestLedger: 42 })),
  upstashRedis: vi.fn(async () => undefined),
  positionSnapshots: vi.fn(async () => ({
    mode: "persistent" as const,
    trackedUsers: 0,
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  clearReadinessCache();
  Object.assign(appNetwork, STELLAR_NETWORKS.mainnet);
});

describe("handleGetLiveness", () => {
  it("returns health metadata without calling external probes", () => {
    const result = handleGetLiveness();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "healthy",
      network: expect.any(String),
      version: expect.any(String),
      build: { version: expect.any(String) },
    });
    expect(checkSorobanRpcHealth).not.toHaveBeenCalled();
    expect(checkUpstashRedisHealth).not.toHaveBeenCalled();
    expect(checkPositionSnapshotStoreHealth).not.toHaveBeenCalled();
  });
});

describe("handleGetReadiness", () => {
  it("reports all independent dependencies and accepts an empty snapshot registry", async () => {
    const result = await handleGetReadiness({
      env: { APP_VERSION: "1.2.3", VERCEL_GIT_COMMIT_SHA: "abc123" },
      probes: baseProbes,
      now: () => 1_000,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "ready",
      network: APP_NETWORK.network,
      version: "1.2.3",
      dependencies: {
        sorobanRpc: { status: "healthy", details: { latestLedger: 42 } },
        upstashRedis: { status: "healthy" },
        positionSnapshots: {
          status: "healthy",
          details: { mode: "persistent", trackedUsers: 0 },
        },
        buildMetadata: { status: "healthy" },
      },
    });
    expect(baseProbes.sorobanRpc).toHaveBeenCalledTimes(1);
    expect(baseProbes.upstashRedis).toHaveBeenCalledTimes(1);
    expect(baseProbes.positionSnapshots).toHaveBeenCalledTimes(1);
  });

  it.each(["mainnet", "testnet"] as const)(
    "uses the active %s APP_NETWORK for both its response and RPC probe",
    async (name) => {
      Object.assign(appNetwork, STELLAR_NETWORKS[name]);
      vi.mocked(checkSorobanRpcHealth).mockResolvedValueOnce({
        latestLedger: 84,
      });
      vi.mocked(checkUpstashRedisHealth).mockResolvedValueOnce(undefined);
      vi.mocked(checkPositionSnapshotStoreHealth).mockResolvedValueOnce({
        trackedUsers: 0,
      });

      const result = await handleGetReadiness({
        env: {
          UPSTASH_REDIS_REST_URL: "https://redis.example",
          UPSTASH_REDIS_REST_TOKEN: "test-token",
        },
        now: () => 2_000,
      });

      expect(result.body).toMatchObject({ network: APP_NETWORK.network });
      expect(checkSorobanRpcHealth).toHaveBeenCalledWith(APP_NETWORK.rpcUrl);
    }
  );

  it.each(["sorobanRpc", "upstashRedis", "positionSnapshots"] as const)(
    "returns 503 when only %s fails",
    async (name) => {
      const probes = {
        ...baseProbes,
        [name]: vi.fn(async () => {
          throw new Error("dependency down");
        }),
      };
      const result = await handleGetReadiness({ probes, now: () => 10_000 });
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({
        status: "not_ready",
        dependencies: { [name]: { status: "unhealthy", error: "unavailable" } },
      });
      expect(probes.sorobanRpc).toHaveBeenCalledTimes(1);
      expect(probes.upstashRedis).toHaveBeenCalledTimes(1);
      expect(probes.positionSnapshots).toHaveBeenCalledTimes(1);
    }
  );

  it("marks missing deployed build metadata unhealthy", async () => {
    const result = await handleGetReadiness({
      env: { VERCEL_ENV: "production" },
      probes: baseProbes,
      now: () => 20_000,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      dependencies: { buildMetadata: { status: "unhealthy" } },
    });
  });

  it("requires persistent snapshot storage when running in a deployment", async () => {
    vi.mocked(checkSorobanRpcHealth).mockResolvedValue({ latestLedger: 7 });
    vi.mocked(checkUpstashRedisHealth).mockResolvedValue(undefined);
    const result = await handleGetReadiness({
      env: { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "abc123" },
      now: () => 25_000,
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      dependencies: {
        upstashRedis: { status: "unhealthy", error: "not_configured" },
        positionSnapshots: {
          status: "unhealthy",
          error: "not_configured",
          details: { mode: "persistent" },
        },
      },
    });
  });

  it("uses in-memory snapshot mode explicitly for local development", async () => {
    const result = await handleGetReadiness({
      env: { APP_VERSION: "local" },
      probes: {
        ...baseProbes,
        positionSnapshots: vi.fn(async () => ({
          mode: "in-memory" as const,
          trackedUsers: 0,
        })),
      },
      now: () => 30_000,
    });
    expect(result.body).toMatchObject({
      dependencies: {
        positionSnapshots: {
          status: "healthy",
          details: { mode: "in-memory", trackedUsers: 0 },
        },
      },
    });
  });

  it("starts all dependency probes concurrently", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const probes = {
      sorobanRpc: vi.fn(async () => {
        started.push("rpc");
        await gate;
        return { latestLedger: 42 };
      }),
      upstashRedis: vi.fn(async () => {
        started.push("redis");
        await gate;
      }),
      positionSnapshots: vi.fn(async () => {
        started.push("snapshots");
        await gate;
        return { mode: "persistent" as const, trackedUsers: 0 };
      }),
    };
    const pending = handleGetReadiness({ probes, now: () => 40_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["rpc", "redis", "snapshots"]);
    release();
    expect((await pending).status).toBe(200);
  });

  it("times out hung dependency probes below the two-second budget", async () => {
    const started = Date.now();
    const result = await handleGetReadiness({
      probes: {
        sorobanRpc: () => new Promise(() => {}),
        upstashRedis: () => new Promise(() => {}),
        positionSnapshots: () => new Promise(() => {}),
      },
      now: () => started,
    });
    expect(result.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(READINESS_TIMEOUT_MS + 100);
    expect(READINESS_TIMEOUT_MS).toBeLessThan(2_000);
  }, 4_000);

  it("reports completed dependency results when the overall deadline expires", async () => {
    const result = await handleGetReadiness({
      readinessTimeoutMs: 10,
      probes: {
        sorobanRpc: vi.fn(async () => ({ latestLedger: 42 })),
        upstashRedis: vi.fn(async () => {
          throw new Error("redis unavailable");
        }),
        positionSnapshots: () => new Promise(() => {}),
      },
      now: () => 45_000,
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      status: "not_ready",
      dependencies: {
        sorobanRpc: { status: "healthy", details: { latestLedger: 42 } },
        upstashRedis: { status: "unhealthy", error: "unavailable" },
        positionSnapshots: { status: "unhealthy", error: "timeout" },
      },
    });
  });

  it("caches healthy readiness briefly, then probes again", async () => {
    let now = 50_000;
    const probes = {
      sorobanRpc: vi.fn(async () => ({ latestLedger: 42 })),
      upstashRedis: vi.fn(async () => undefined),
      positionSnapshots: vi.fn(async () => ({
        mode: "persistent" as const,
        trackedUsers: 0,
      })),
    };
    await handleGetReadiness({ probes, now: () => now });
    now += READINESS_CACHE_TTL_MS - 1;
    await handleGetReadiness({ probes, now: () => now });
    expect(probes.sorobanRpc).toHaveBeenCalledTimes(1);
    now += 2;
    await handleGetReadiness({ probes, now: () => now });
    expect(probes.sorobanRpc).toHaveBeenCalledTimes(2);
  });

  it("caches unhealthy results briefly and rechecks after the negative cache expires", async () => {
    let healthy = false;
    const probes = {
      sorobanRpc: vi.fn(async () => ({ latestLedger: 42 })),
      upstashRedis: vi.fn(async () => undefined),
      positionSnapshots: vi.fn(async () => {
        if (!healthy) throw new Error("unavailable");
        return { mode: "persistent" as const, trackedUsers: 0 };
      }),
    };

    expect(
      (await handleGetReadiness({ probes, now: () => 60_000 })).status
    ).toBe(503);

    expect(
      (await handleGetReadiness({ probes, now: () => 60_001 })).status
    ).toBe(503);
    expect(probes.positionSnapshots).toHaveBeenCalledTimes(1);

    healthy = true;
    expect(
      (
        await handleGetReadiness({
          probes,
          now: () => 60_000 + READINESS_NEGATIVE_CACHE_TTL_MS,
        })
      ).status
    ).toBe(200);
    expect(probes.positionSnapshots).toHaveBeenCalledTimes(2);
  });

  it("rechecks readiness after a healthy cache entry expires and returns 503 on failure", async () => {
    let now = 70_000;
    let snapshotsAvailable = true;
    const probes = {
      sorobanRpc: vi.fn(async () => ({ latestLedger: 42 })),
      upstashRedis: vi.fn(async () => undefined),
      positionSnapshots: vi.fn(async () => {
        if (!snapshotsAvailable) throw new Error("snapshot store unavailable");
        return { mode: "persistent" as const, trackedUsers: 0 };
      }),
    };

    expect((await handleGetReadiness({ probes, now: () => now })).status).toBe(
      200
    );
    snapshotsAvailable = false;
    now += READINESS_CACHE_TTL_MS;

    const result = await handleGetReadiness({ probes, now: () => now });

    expect(result.status).toBe(503);
    expect(probes.positionSnapshots).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached readiness when Redis configuration changes without exposing credentials", async () => {
    let now = 80_000;
    const probes = {
      sorobanRpc: vi.fn(async () => ({ latestLedger: 42 })),
      upstashRedis: vi.fn(async () => undefined),
      positionSnapshots: vi.fn(async () => ({
        mode: "persistent" as const,
        trackedUsers: 0,
      })),
    };
    const firstEnv = {
      UPSTASH_REDIS_REST_URL: "https://redis-one.example",
      UPSTASH_REDIS_REST_TOKEN: "secret-one",
    };
    const secondEnv = {
      UPSTASH_REDIS_REST_URL: "https://redis-two.example",
      UPSTASH_REDIS_REST_TOKEN: "secret-two",
    };

    expect(
      (await handleGetReadiness({ env: firstEnv, probes, now: () => now }))
        .status
    ).toBe(200);
    now += 1;
    const result = await handleGetReadiness({
      env: secondEnv,
      probes,
      now: () => now,
    });

    expect(result.status).toBe(200);
    expect(probes.sorobanRpc).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result.body)).not.toContain("secret-two");
    expect(JSON.stringify(result.body)).not.toContain("redis-two.example");
  });
});
