import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchAllVaults, clearVaultCache } from "./vaults";

// Maps to blend-usdc-fixed in known-pools.ts.
const KNOWN_BLEND = "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf";

function llamaPool(overrides: Record<string, unknown> = {}) {
  return {
    pool: KNOWN_BLEND,
    project: "blend",
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apy: 5.123,
    apyPct1D: 0,
    apyPct7D: 0,
    apyPct30D: 0,
    poolMeta: null,
    stablecoin: true,
    chain: "Stellar",
    ...overrides,
  };
}

function stubPools(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }))
  );
}

describe("fetchAllVaults", () => {
  beforeEach(() => clearVaultCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearVaultCache();
  });

  it("maps known DeFiLlama pools and rounds APY to two decimals", async () => {
    stubPools([llamaPool()]);
    const vaults = await fetchAllVaults();
    expect(vaults).toHaveLength(1);
    expect(vaults[0].id).toBe("blend-usdc-fixed");
    expect(vaults[0].protocol).toBe("blend");
    expect(vaults[0].apy).toBe(5.12);
    expect(vaults[0].riskLevel).toBe("safe");
  });

  it("skips pools with no known-pool mapping", async () => {
    stubPools([llamaPool({ pool: "unrecognised-id" })]);
    expect(await fetchAllVaults()).toEqual([]);
  });

  it("no longer emits a placeholder DeFindex vault", async () => {
    stubPools([]);
    const vaults = await fetchAllVaults();
    expect(vaults.find((v) => v.protocol === "defindex")).toBeUndefined();
  });

  it("returns cached result and skips DeFiLlama on repeated calls within TTL", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [llamaPool()] }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAllVaults();
    await fetchAllVaults();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("serves stale cache instead of empty list when DeFiLlama returns no pools", async () => {
    // Prime the cache with a valid vault list.
    stubPools([llamaPool()]);
    const first = await fetchAllVaults();
    expect(first).toHaveLength(1);

    // Now simulate a DeFiLlama blip — all pools gone — after TTL expiry.
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    stubPools([]);
    const second = await fetchAllVaults();

    // Should return the previous cache, not an empty array.
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("blend-usdc-fixed");
  });

  it("re-fetches from DeFiLlama after the 60 s TTL expires", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [llamaPool()] }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAllVaults();
    vi.advanceTimersByTime(61_000);
    await fetchAllVaults();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
