import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPositionCacheForTesting,
  getCachedPositions,
  positionCacheKey,
  setCachedPositions,
} from "./position-cache";

const POSITIONS = [
  {
    vaultId: "meridian-usdc",
    shares: 12,
    deposited: 10,
    earned: 1,
    entryTime: 123,
  },
];
const ENV = {
  UPSTASH_REDIS_REST_URL: "https://redis.example",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

beforeEach(() => clearPositionCacheForTesting());
afterEach(() => vi.restoreAllMocks());

describe("positionCacheKey", () => {
  it("includes network, wallet, and ledger", () => {
    expect(positionCacheKey("testnet", "GABC", 42)).toBe(
      "position-cache:testnet:GABC:42"
    );
  });
});

describe("shared position cache", () => {
  it("reads and writes positions through Upstash with a short TTL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "OK" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: JSON.stringify(POSITIONS) }), {
          status: 200,
        })
      );
    const options = { env: ENV, fetchImpl };

    await setCachedPositions("mainnet", "GABC", 42, POSITIONS, options);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual([
      "SETEX",
      "position-cache:mainnet:GABC:42",
      15,
      JSON.stringify(POSITIONS),
    ]);

    clearPositionCacheForTesting();
    const cached = await getCachedPositions("mainnet", "GABC", 42, options);
    expect(cached).toEqual(POSITIONS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual([
      "GET",
      "position-cache:mainnet:GABC:42",
    ]);
  });

  it("returns null when the in-process entry has expired", async () => {
    await setCachedPositions("mainnet", "GABC", 42, POSITIONS, {
      env: {},
      ttlSeconds: 0,
    });
    await expect(
      getCachedPositions("mainnet", "GABC", 42, {
        env: {},
        ttlSeconds: 0,
      })
    ).resolves.toBeNull();
  });

  it("removes expired entries when storing a new position", async () => {
    await setCachedPositions("mainnet", "GABC", 42, POSITIONS, {
      env: {},
      ttlSeconds: 0,
    });
    await setCachedPositions("mainnet", "GDEF", 42, POSITIONS, { env: {} });

    await expect(
      getCachedPositions("mainnet", "GABC", 42, { env: {} })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "GDEF", 42, { env: {} })
    ).resolves.toEqual(POSITIONS);
  });

  it("evicts the oldest entry when the in-process cache reaches its limit", async () => {
    for (let index = 0; index < 1_001; index += 1) {
      await setCachedPositions("mainnet", `G${index}`, 42, POSITIONS, {
        env: {},
      });
    }

    await expect(
      getCachedPositions("mainnet", "G0", 42, { env: {} })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "G1000", 42, { env: {} })
    ).resolves.toEqual(POSITIONS);
  });

  it("supports the Upstash Marketplace credential names", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: "OK" }), { status: 200 })
      );
    await setCachedPositions("mainnet", "GABC", 42, POSITIONS, {
      env: {
        UPSTASH_REDIS_REST_KV_REST_API_URL: "https://redis.example/",
        UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "test-token",
      },
      fetchImpl,
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://redis.example");
  });

  it("treats missing credentials, Redis errors, and invalid cached data as misses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Redis unavailable" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "not-json" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: JSON.stringify([{}]) }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: JSON.stringify([{}]) }), {
          status: 200,
        })
      );

    await expect(
      getCachedPositions("mainnet", "GABC", 42, {
        env: { UPSTASH_REDIS_REST_URL: "https://redis.example" },
      })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "GABC", 42, { env: {} })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "GABC", 42, { env: ENV, fetchImpl })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "GABC", 43, { env: ENV, fetchImpl })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "GABC", 44, { env: ENV, fetchImpl })
    ).resolves.toBeNull();
  });

  it("logs and falls back when Upstash requests fail", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Redis unavailable" }), {
          status: 200,
        })
      )
      .mockRejectedValueOnce("network down");

    await expect(
      getCachedPositions("mainnet", "GABC", 42, { env: ENV, fetchImpl })
    ).resolves.toBeNull();
    await expect(
      getCachedPositions("mainnet", "GHIJ", 42, { env: ENV, fetchImpl })
    ).resolves.toBeNull();
    await setCachedPositions("mainnet", "GDEF", 42, POSITIONS, {
      env: ENV,
      fetchImpl,
    });

    expect(errorLog).toHaveBeenCalledTimes(3);
    await expect(
      getCachedPositions("mainnet", "GDEF", 42, { env: {} })
    ).resolves.toEqual(POSITIONS);
  });

  it("uses the global fetch implementation when no override is provided", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: "OK" }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchImpl);

    await setCachedPositions("mainnet", "GABC", 42, POSITIONS, { env: ENV });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
