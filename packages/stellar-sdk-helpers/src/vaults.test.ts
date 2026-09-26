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

import { simulateView } from "./tx";
import { toBigInt } from "./internal";
import { fetchAllVaults, clearVaultCache, isVaultCacheWarm } from "./vaults";
import { KNOWN_POOLS } from "./known-pools";

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

describe("fetchAllVaults (mainnet)", () => {
  beforeEach(() => {
    clearVaultCache();
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
  });

  it("skips pools with no known-pool mapping while preserving the live Meridian vault", async () => {
    stubPools([llamaPool({ pool: "unrecognised-id" })]);
    const vaults = await fetchAllVaults("mainnet");
    expect(vaults).toHaveLength(1);
    expect(vaults[0].id).toBe("meridian-usdc");
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
  });

  it("serves stale cache instead of dropping third-party pools when DeFiLlama returns no pools", async () => {
    // Prime the cache with a valid vault list.
    stubPools([llamaPool()]);
    const first = await fetchAllVaults("mainnet");
    expect(first.some((v) => v.id === "blend-usdc-fixed")).toBe(true);
    expect(first.some((v) => v.id === "meridian-usdc")).toBe(true);

    // Now simulate a DeFiLlama blip — all pools gone — after TTL expiry.
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

  it("skips Meridian vaults that lack contractId or assetId", async () => {
    const incompleteVaultId = "meridian-incomplete";
    KNOWN_POOLS.mainnet[incompleteVaultId] = {
      id: incompleteVaultId,
      name: "Incomplete Vault",
      protocol: "meridian",
      label: "Incomplete",
    };

    try {
      stubPools([]);
      const vaults = await fetchAllVaults("mainnet");
      expect(vaults.find((v) => v.id === incompleteVaultId)).toBeUndefined();
    } finally {
      delete KNOWN_POOLS.mainnet[incompleteVaultId];
    }
  });

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
    expect(vaults[0].id).toBe("meridian-usdc");
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
      KNOWN_POOLS.mainnet["meridian-usdc"] = origMeridian;
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
    expect(vaults[0].id).toBe("meridian-usdc");
    expect(vaults[0].protocol).toBe("meridian");
    expect(vaults[0].tvl).toBe(1000);
    expect(vaults[0].riskLevel).toBe("safe");
  });

  it("returns zero TVL when get_total_assets returns zero", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "none" });
    vi.mocked(toBigInt).mockReturnValue(0n);

    const vaults = await fetchAllVaults("testnet");
    expect(vaults[0].tvl).toBe(0);
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
    expect(vaults[0].apy).toBe(8);
  });

  it("returns apy 0 without querying Blend when the adapter wraps an unrecognised protocol", async () => {
    mockAdapterDiscovery({ totalAssets: 0n, protocol: "defindex" });
    vi.mocked(toBigInt).mockReturnValue(0n);
    const loadSpy = vi.spyOn(PoolV2, "load");

    const vaults = await fetchAllVaults("testnet");

    expect(vaults[0].apy).toBe(0);
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
