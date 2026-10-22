import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { PoolV2 } from "@blend-capital/blend-sdk";

vi.mock("./tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tx")>();
  return { ...actual, simulateView: vi.fn() };
});

vi.mock("./internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./internal")>();
  return {
    ...actual,
    getRpcServer: vi.fn(() => ({})),
    toBigInt: vi.fn((v: unknown) => (v ?? 0n) as bigint),
  };
});

vi.mock("./vault-cache", () => ({
  getCachedVaults: vi.fn(),
  setCachedVaults: vi.fn(),
}));

import { simulateView } from "./tx";
import { toBigInt } from "./internal";
import {
  fetchAllVaults,
  fetchVaultsWithCache,
  clearVaultCache,
  isVaultCacheWarm,
} from "./vaults";
import { getCachedVaults, setCachedVaults } from "./vault-cache";
import { KNOWN_POOLS } from "./known-pools";

beforeEach(() => {
  vi.mocked(getCachedVaults).mockReset().mockResolvedValue(null);
  vi.mocked(setCachedVaults).mockReset().mockResolvedValue(undefined);
});

// Mainnet DeFiLlama pool UUID mapping to blend-usdc-fixed in KNOWN_POOLS.mainnet.
const KNOWN_BLEND = "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf";
const ADAPTER_ID = "CADAPTER00000000000000000000000000000000000000000000000000";
const POOL_ID = "CPOOL0000000000000000000000000000000000000000000000000000";

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

// Mocks simulateView's `method` param (5th positional arg after server,
// contractId, passphrase, method) so different on-chain calls can return
// different values, matching how fetchMeridianApy actually calls it.
function mockAdapterDiscovery(opts: {
  totalAssets?: bigint;
  protocol?: string;
  adapterId?: string;
}) {
  vi.mocked(simulateView).mockImplementation(
    async (_server, _contractId, _passphrase, method) => {
      switch (method) {
        case "get_total_assets":
          return (opts.totalAssets ?? 0n) as never;
        case "get_adapter":
          return (
            opts.adapterId !== undefined ? opts.adapterId : ADAPTER_ID
          ) as never;
        case "get_pool":
          return POOL_ID as never;
        case "get_protocol":
          return (opts.protocol ?? "blend") as never;
        default:
          throw new Error(`unexpected simulateView method: ${String(method)}`);
      }
    }
  );
}

describe("isVaultCacheWarm", () => {
  beforeEach(() => clearVaultCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearVaultCache();
  });

  it("returns false when cache is empty", () => {
    expect(isVaultCacheWarm()).toBe(false);
  });

  it("returns true when cache is populated and not expired, and false after expiry", async () => {
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    stubPools([llamaPool()]);

    await fetchAllVaults("mainnet");
    expect(isVaultCacheWarm()).toBe(true);

    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    expect(isVaultCacheWarm()).toBe(false);
  });
});

describe("fetchVaultsWithCache", () => {
  beforeEach(() => {
    clearVaultCache();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearVaultCache();
  });

  it("returns cached: false after fresh mainnet fetch and cached: true on subsequent warm call", async () => {
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    stubPools([llamaPool()]);

    const first = await fetchVaultsWithCache("mainnet");
    expect(first.cached).toBe(false);

    const second = await fetchVaultsWithCache("mainnet");
    expect(second.cached).toBe(true);
  });

  it("returns cached: false on testnet calls", async () => {
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    const res = await fetchVaultsWithCache("testnet");
    expect(res.cached).toBe(false);
  });
});

describe("fetchAllVaults (mainnet)", () => {
  beforeEach(() => {
    clearVaultCache();
    vi.clearAllMocks();
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(10_000_000_000n);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearVaultCache();
  });

  it("maps known DeFiLlama pools and includes live Meridian vault with on-chain data", async () => {
    stubPools([llamaPool()]);
    const vaults = await fetchAllVaults("mainnet");

    // Both the on-chain Meridian vault and the DeFiLlama Blend pool should be emitted.
    expect(vaults).toHaveLength(2);

    const meridianVault = vaults.find((v) => v.id === "meridian-usdc");
    expect(meridianVault).toBeDefined();
    expect(meridianVault?.protocol).toBe("meridian");
    expect(meridianVault?.tvl).toBe(1000);
    expect(meridianVault?.asset).toBe("USDC");
    expect(meridianVault?.riskLevel).toBe("safe");

    const blendVault = vaults.find((v) => v.id === "blend-usdc-fixed");
    expect(blendVault).toBeDefined();
    expect(blendVault?.protocol).toBe("blend");
    expect(blendVault?.apy).toBe(5.12);
    expect(blendVault?.riskLevel).toBe("safe");
    expect(isVaultCacheWarm()).toBe(true);
    expect(setCachedVaults).toHaveBeenCalledExactlyOnceWith("mainnet", vaults);
  });

  it("skips pools with no known-pool mapping while preserving the live Meridian vault", async () => {
    stubPools([llamaPool({ pool: "unrecognised-id" })]);
    const vaults = await fetchAllVaults("mainnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.id).toBe("meridian-usdc");
  });

  it("no longer emits a placeholder DeFindex vault", async () => {
    stubPools([]);
    const vaults = await fetchAllVaults("mainnet");
    expect(vaults.find((v) => v.protocol === "defindex")).toBeUndefined();
  });

  it("returns cached result and skips DeFiLlama on repeated calls within TTL", async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [llamaPool()] }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAllVaults("mainnet");
    await fetchAllVaults("mainnet");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(getCachedVaults).toHaveBeenCalledOnce();
    expect(setCachedVaults).toHaveBeenCalledOnce();
  });

  it("warms L1 from a shared cache hit without fetching or rewriting vaults", async () => {
    stubPools([llamaPool()]);
    const first = await fetchAllVaults("mainnet");
    clearVaultCache();
    vi.clearAllMocks();
    vi.mocked(getCachedVaults).mockResolvedValueOnce(first);

    expect(await fetchAllVaults("mainnet")).toBe(first);
    expect(await fetchAllVaults("mainnet")).toBe(first);
    expect(isVaultCacheWarm()).toBe(true);
    expect(getCachedVaults).toHaveBeenCalledExactlyOnceWith("mainnet");
    expect(simulateView).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(setCachedVaults).not.toHaveBeenCalled();
  });

  it("reports cached: true via fetchVaultsWithCache on shared L2 cache hit", async () => {
    stubPools([llamaPool()]);
    const first = await fetchAllVaults("mainnet");
    clearVaultCache();
    vi.clearAllMocks();
    vi.mocked(getCachedVaults).mockResolvedValueOnce(first);

    const res = await fetchVaultsWithCache("mainnet");
    expect(res.cached).toBe(true);
    expect(res.vaults).toBe(first);
    expect(isVaultCacheWarm()).toBe(true);
    expect(getCachedVaults).toHaveBeenCalledExactlyOnceWith("mainnet");
    expect(simulateView).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves stale cache instead of dropping third-party pools when DeFiLlama returns no pools", async () => {
    // Prime the cache with a valid vault list.
    stubPools([llamaPool()]);
    const first = await fetchAllVaults("mainnet");
    expect(first.some((v) => v.id === "blend-usdc-fixed")).toBe(true);
    expect(first.some((v) => v.id === "meridian-usdc")).toBe(true);

    // After the TTL expires, simulate a DeFiLlama blip that drops every pool.
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    stubPools([]);
    const second = await fetchAllVaults("mainnet");

    // Should preserve the previous DeFiLlama pool from cache alongside Meridian vault.
    expect(second.some((v) => v.id === "blend-usdc-fixed")).toBe(true);
    expect(second.some((v) => v.id === "meridian-usdc")).toBe(true);
  });

  it("re-fetches from DeFiLlama after the 60 s TTL expires", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [llamaPool()] }), { status: 200 })
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchAllVaults("mainnet");
    vi.advanceTimersByTime(61_000);
    await fetchAllVaults("mainnet");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches live Blend APY for Meridian vault on mainnet when adapter wraps Blend", async () => {
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "blend" });
    vi.mocked(toBigInt).mockReturnValue(10_000_000_000n);
    const usdcAssetId =
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
    const loadSpy = vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map([
        [usdcAssetId, { totalSupply: () => 0n, estSupplyApy: 0.08 }],
      ]),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);
    stubPools([]);

    const vaults = await fetchAllVaults("mainnet");
    const meridianVault = vaults.find((v) => v.id === "meridian-usdc");

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: expect.any(String) }),
      POOL_ID
    );
    expect(meridianVault?.apy).toBe(8);
  });

  it("returns 0 APY when the active adapter Blend pool lacks the requested reserve", async () => {
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "blend" });
    vi.mocked(toBigInt).mockReturnValue(10_000_000_000n);
    vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map([
        ["OTHER_ASSET", { totalSupply: () => 0n, estSupplyApy: 0.1 }],
      ]),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);
    stubPools([]);

    const vaults = await fetchAllVaults("mainnet");
    const meridianVault = vaults.find((v) => v.id === "meridian-usdc");
    expect(meridianVault?.apy).toBe(0);
  });

  it("returns 0 APY when get_adapter returns empty or falsy adapterId", async () => {
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, adapterId: "" });
    stubPools([]);

    const vaults = await fetchAllVaults("mainnet");
    const meridianVault = vaults.find((v) => v.id === "meridian-usdc");
    expect(meridianVault?.apy).toBe(0);
  });

  it.each(["contractId", "assetId"] as const)(
    "still caches vaults when Meridian legitimately lacks %s",
    async (missingField) => {
      const original = KNOWN_POOLS.mainnet["meridian-usdc"];
      const incomplete = { ...original! };
      delete incomplete[missingField];
      KNOWN_POOLS.mainnet["meridian-usdc"] = incomplete;

      try {
        stubPools([llamaPool()]);
        const vaults = await fetchAllVaults("mainnet");
        expect(vaults.map((v) => v.id)).toEqual(["blend-usdc-fixed"]);
        expect(simulateView).not.toHaveBeenCalled();
        expect(isVaultCacheWarm()).toBe(true);
        expect(setCachedVaults).toHaveBeenCalledExactlyOnceWith(
          "mainnet",
          vaults
        );
        expect(await fetchAllVaults("mainnet")).toBe(vaults);
      } finally {
        KNOWN_POOLS.mainnet["meridian-usdc"] = original!;
      }
    }
  );

  it("defaults asset to USDC when meta.asset is undefined", async () => {
    const noAssetVaultId = "meridian-no-asset";
    KNOWN_POOLS.mainnet[noAssetVaultId] = {
      id: noAssetVaultId,
      name: "No Asset Vault",
      protocol: "meridian",
      label: "No Asset",
      contractId: "CNOASSET00000000000000000000000000000000000000000000000000",
      assetId: "CASSET0000000000000000000000000000000000000000000000000000",
    };

    try {
      mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
      stubPools([]);
      const vaults = await fetchAllVaults("mainnet");
      const found = vaults.find((v) => v.id === noAssetVaultId);
      expect(found).toBeDefined();
      expect(found?.asset).toBe("USDC");
    } finally {
      delete KNOWN_POOLS.mainnet[noAssetVaultId];
    }
  });

  it("handles DeFiLlama fetch failure gracefully and still returns on-chain Meridian vault", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("DeFiLlama network error");
      })
    );
    const vaults = await fetchAllVaults("mainnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.id).toBe("meridian-usdc");
  });

  it("serves stale Meridian data without renewing either cache and retries immediately", async () => {
    // Prime the cache with a healthy on-chain read.
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(10_000_000_000n);
    stubPools([llamaPool()]);
    const first = await fetchAllVaults("mainnet");
    expect(first.find((v) => v.id === "meridian-usdc")?.tvl).toBe(1000);

    // After the TTL, the on-chain read rejects; the cached vault stands in.
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    vi.mocked(simulateView).mockRejectedValue(new Error("Soroban RPC down"));
    stubPools([llamaPool({ apy: 9 })]);
    const second = await fetchAllVaults("mainnet");

    const cached = second.find((v) => v.id === "meridian-usdc");
    expect(cached).toBeDefined();
    expect(cached?.tvl).toBe(1000);
    expect(second.some((v) => v.id === "blend-usdc-fixed")).toBe(true);
    expect(second.find((v) => v.id === "blend-usdc-fixed")?.apy).toBe(9);
    expect(isVaultCacheWarm()).toBe(false);
    expect(setCachedVaults).toHaveBeenCalledExactlyOnceWith("mainnet", first);

    // Another outage must still fall back to the last good L1 payload.
    stubPools([]);
    expect(await fetchAllVaults("mainnet")).toEqual(first);
    expect(isVaultCacheWarm()).toBe(false);
    expect(setCachedVaults).toHaveBeenCalledOnce();

    mockAdapterDiscovery({ totalAssets: 20_000_000_000n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(20_000_000_000n);
    stubPools([llamaPool()]);
    const recovered = await fetchAllVaults("mainnet");
    expect(recovered.find((v) => v.id === "meridian-usdc")?.tvl).toBe(2000);
    expect(isVaultCacheWarm()).toBe(true);
    expect(setCachedVaults).toHaveBeenCalledTimes(2);
    expect(setCachedVaults).toHaveBeenLastCalledWith("mainnet", recovered);
  });

  it.each(["get_total_assets", "get_adapter"])(
    "does not cache a cold %s failure and caches the next successful refresh",
    async (failedMethod) => {
      const healthyRead = vi.mocked(simulateView).getMockImplementation()!;
      vi.mocked(simulateView).mockImplementation((...args) => {
        if (args[3] === failedMethod) {
          return Promise.reject(new Error("Soroban RPC down"));
        }
        return healthyRead(...args);
      });
      stubPools([llamaPool()]);
      const vaults = await fetchAllVaults("mainnet");

      expect(vaults.map((v) => v.id)).toEqual(["blend-usdc-fixed"]);
      expect(isVaultCacheWarm()).toBe(false);
      expect(setCachedVaults).not.toHaveBeenCalled();

      expect(await fetchAllVaults("mainnet")).toEqual(vaults);
      expect(getCachedVaults).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(isVaultCacheWarm()).toBe(false);
      expect(setCachedVaults).not.toHaveBeenCalled();

      mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
      const recovered = await fetchAllVaults("mainnet");
      expect(recovered.map((v) => v.id)).toEqual([
        "meridian-usdc",
        "blend-usdc-fixed",
      ]);
      expect(isVaultCacheWarm()).toBe(true);
      expect(setCachedVaults).toHaveBeenCalledExactlyOnceWith(
        "mainnet",
        recovered
      );

      vi.mocked(simulateView).mockClear();
      expect(await fetchAllVaults("mainnet")).toBe(recovered);
      expect(simulateView).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(getCachedVaults).toHaveBeenCalledTimes(3);
      expect(setCachedVaults).toHaveBeenCalledOnce();
    }
  );

  it("does not cache healthy vaults when another configured Meridian vault fails", async () => {
    const failingId = "meridian-failing";
    const failingContract = "CFAILING";
    KNOWN_POOLS.mainnet[failingId] = {
      id: failingId,
      name: "Failing Meridian Vault",
      protocol: "meridian",
      label: "Failing Vault",
      contractId: failingContract,
      assetId: "CASSET",
    };
    const healthyRead = vi.mocked(simulateView).getMockImplementation()!;
    vi.mocked(simulateView).mockImplementation((...args) => {
      if (args[1] === failingContract) {
        return Promise.reject(new Error("Soroban RPC down"));
      }
      return healthyRead(...args);
    });

    try {
      stubPools([llamaPool()]);
      const vaults = await fetchAllVaults("mainnet");
      expect(vaults.map((v) => v.id)).toEqual([
        "meridian-usdc",
        "blend-usdc-fixed",
      ]);
      expect(isVaultCacheWarm()).toBe(false);
      expect(setCachedVaults).not.toHaveBeenCalled();
    } finally {
      delete KNOWN_POOLS.mainnet[failingId];
    }
  });

  it("prevents duplicates when DeFiLlama returns a pool matching a Meridian vault id", async () => {
    stubPools([
      llamaPool({ pool: "meridian-usdc" }),
      llamaPool({ pool: KNOWN_BLEND }),
    ]);
    const vaults = await fetchAllVaults("mainnet");
    const meridianVaults = vaults.filter((v) => v.id === "meridian-usdc");
    expect(meridianVaults).toHaveLength(1);
    expect(vaults.some((v) => v.id === "blend-usdc-fixed")).toBe(true);
  });

  it("returns empty array when no vaults are found and cache is empty", async () => {
    const origMeridian = KNOWN_POOLS.mainnet["meridian-usdc"];
    delete KNOWN_POOLS.mainnet["meridian-usdc"];

    try {
      stubPools([]);
      const vaults = await fetchAllVaults("mainnet");
      expect(vaults).toEqual([]);
    } finally {
      KNOWN_POOLS.mainnet["meridian-usdc"] = origMeridian!;
    }
  });
});

describe("fetchAllVaults (testnet)", () => {
  beforeEach(() => {
    clearVaultCache();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearVaultCache();
  });

  it("returns meridian vault with TVL derived from get_total_assets", async () => {
    // 1 000 USDC = 10_000_000_000 stroops (7 decimal places).
    mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(10_000_000_000n);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.id).toBe("meridian-usdc");
    expect(vaults[0]!.protocol).toBe("meridian");
    expect(vaults[0]!.tvl).toBe(1000);
    expect(vaults[0]!.riskLevel).toBe("safe");
  });

  it("returns zero TVL when get_total_assets returns zero", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(0n);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults[0]!.tvl).toBe(0);
  });

  it("does not cache testnet results between calls", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(0n);

    await fetchAllVaults("testnet");
    await fetchAllVaults("testnet");

    const totalAssetsCalls = vi
      .mocked(simulateView)
      .mock.calls.filter(([, , , method]) => method === "get_total_assets");
    expect(totalAssetsCalls).toHaveLength(2);
  });

  it("fetches live Blend APY when the active adapter wraps a Blend pool", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "blend" });
    vi.mocked(toBigInt).mockReturnValue(0n);
    const usdcAssetId =
      "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
    const loadSpy = vi.spyOn(PoolV2, "load").mockResolvedValue({
      reserves: new Map([
        [usdcAssetId, { totalSupply: () => 0n, estSupplyApy: 0.08 }],
      ]),
    } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

    const vaults = await fetchAllVaults("testnet");

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: expect.any(String) }),
      POOL_ID
    );
    expect(vaults[0]!.apy).toBe(8);
  });

  it("returns apy 0 without querying Blend when the adapter wraps an unrecognised protocol", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "defindex" });
    vi.mocked(toBigInt).mockReturnValue(0n);
    const loadSpy = vi.spyOn(PoolV2, "load");

    const vaults = await fetchAllVaults("testnet");

    expect(vaults[0]!.apy).toBe(0);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("processes Blend protocol pools in KNOWN_POOLS.testnet with and without reserves", async () => {
    const dummyPoolId = "testnet-blend-pool";
    const dummyAssetId = "testnet-blend-asset";
    const blendMeta = {
      id: dummyPoolId,
      name: "Blend Test",
      protocol: "blend" as const,
      label: "Blend Pool",
      contractId: "CBLEND0000000000000000000000000000000000000000000000000000",
      assetId: dummyAssetId,
      asset: "USDC",
    };

    KNOWN_POOLS.testnet[dummyPoolId] = blendMeta;

    try {
      // Case 1: reserve exists
      const loadSpy = vi.spyOn(PoolV2, "load").mockResolvedValue({
        reserves: new Map([
          [
            dummyAssetId,
            { totalSupply: () => 50_000_000_000n, estSupplyApy: 0.05 },
          ],
        ]),
      } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

      mockAdapterDiscovery({ totalAssets: 10_000_000_000n, protocol: "none" });
      let vaults = await fetchAllVaults("testnet");
      const foundWithReserve = vaults.find((v) => v.id === dummyPoolId);
      expect(foundWithReserve).toBeDefined();
      expect(foundWithReserve?.tvl).toBe(5000);
      expect(foundWithReserve?.apy).toBe(5);

      // Case 2: reserve does not exist in reserves map
      loadSpy.mockResolvedValue({
        reserves: new Map(),
      } as unknown as Awaited<ReturnType<typeof PoolV2.load>>);

      vaults = await fetchAllVaults("testnet");
      const foundWithoutReserve = vaults.find((v) => v.id === dummyPoolId);
      expect(foundWithoutReserve).toBeDefined();
      expect(foundWithoutReserve?.tvl).toBe(0);
      expect(foundWithoutReserve?.apy).toBe(0);
    } finally {
      delete KNOWN_POOLS.testnet[dummyPoolId];
    }
  });
});
