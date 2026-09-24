import { describe, it, expect, vi, beforeEach } from "vitest";
import { blendAssetForVault, fetchBlendPositions } from "./blend";
import type { StellarNetwork } from "./types";

// Mock the Blend SDK so fetchBlendPositions never touches the network.
vi.mock("@blend-capital/blend-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@blend-capital/blend-sdk")>();
  return {
    ...actual,
    PoolV2: {
      load: vi.fn(),
    },
  };
});

import { PoolV2 } from "@blend-capital/blend-sdk";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const POOL_ID = "CPOOL0000000000000000000000000000000000000000000000000000";
const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ID = "CUSDC0000000000000000000000000000000000000000000000000000";
const EURC_ID = "CEURC0000000000000000000000000000000000000000000000000000";

const reserves = [
  { assetId: USDC_ID, vaultId: "blend-usdc-fixed" },
  { assetId: EURC_ID, vaultId: "blend-eurc-fixed" },
];

function makePool(
  reserveMap: Map<string, object>,
  userBalances: Record<string, { collateral: number; supply: number }>
) {
  const fakePool = {
    reserves: reserveMap,
    loadUser: vi.fn(async (_publicKey: string) => ({
      getCollateralFloat: (reserve: object) => {
        const id =
          [...reserveMap.entries()].find(([, r]) => r === reserve)?.[0] ?? "";
        return userBalances[id]?.collateral ?? 0;
      },
      getSupplyFloat: (reserve: object) => {
        const id =
          [...reserveMap.entries()].find(([, r]) => r === reserve)?.[0] ?? "";
        return userBalances[id]?.supply ?? 0;
      },
    })),
  };
  return fakePool;
}

beforeEach(() => vi.clearAllMocks());

describe("blendAssetForVault", () => {
  it("maps USDC vault ids to the usdc reserve", () => {
    expect(blendAssetForVault("blend-usdc-fixed")).toBe("usdc");
    expect(blendAssetForVault("blend-usdc-variable")).toBe("usdc");
  });

  it("maps EURC vault ids to the eurc reserve", () => {
    expect(blendAssetForVault("blend-eurc-fixed")).toBe("eurc");
    expect(blendAssetForVault("blend-eurc-variable")).toBe("eurc");
  });

  it("throws for a vault id with no mapped reserve asset", () => {
    expect(() => blendAssetForVault("blend-xlm-fixed")).toThrow(
      /no blend reserve asset/i
    );
  });
});

describe("fetchBlendPositions", () => {
  it("returns [] when the user holds no positions in any reserve", async () => {
    const reserveMap = new Map<string, object>([
      [USDC_ID, {}],
      [EURC_ID, {}],
    ]);
    const pool = makePool(reserveMap, {});
    vi.mocked(PoolV2.load).mockResolvedValue(pool as never);

    const result = await fetchBlendPositions(
      network,
      POOL_ID,
      PUBKEY,
      reserves
    );
    expect(result).toEqual([]);
    expect(pool.loadUser).toHaveBeenCalledWith(PUBKEY);
  });

  it("returns a position for each reserve the user holds collateral in", async () => {
    const reserveMap = new Map<string, object>([
      [USDC_ID, {}],
      [EURC_ID, {}],
    ]);
    const pool = makePool(reserveMap, {
      [USDC_ID]: { collateral: 50, supply: 0 },
      [EURC_ID]: { collateral: 20, supply: 0 },
    });
    vi.mocked(PoolV2.load).mockResolvedValue(pool as never);

    const result = await fetchBlendPositions(
      network,
      POOL_ID,
      PUBKEY,
      reserves
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      vaultId: "blend-usdc-fixed",
      shares: 50,
      deposited: 50,
      earned: 0,
      entryTime: 0,
    });
    expect(result[1]).toMatchObject({
      vaultId: "blend-eurc-fixed",
      shares: 20,
      deposited: 20,
      earned: 0,
      entryTime: 0,
    });
  });

  it("sets shares to collateral-only and deposited to collateral + plain supply", async () => {
    const reserveMap = new Map<string, object>([[USDC_ID, {}]]);
    const pool = makePool(reserveMap, {
      [USDC_ID]: { collateral: 30, supply: 10 },
    });
    vi.mocked(PoolV2.load).mockResolvedValue(pool as never);

    const [pos] = await fetchBlendPositions(network, POOL_ID, PUBKEY, [
      reserves[0],
    ]);
    expect(pos.shares).toBe(30);
    expect(pos.deposited).toBe(40);
  });

  it("skips reserves not present in the pool", async () => {
    const reserveMap = new Map<string, object>([[USDC_ID, {}]]);
    const pool = makePool(reserveMap, {
      [USDC_ID]: { collateral: 10, supply: 0 },
    });
    vi.mocked(PoolV2.load).mockResolvedValue(pool as never);

    // Both USDC and EURC passed, but only USDC is in the pool's reserve map.
    const result = await fetchBlendPositions(
      network,
      POOL_ID,
      PUBKEY,
      reserves
    );
    expect(result).toHaveLength(1);
    expect(result[0].vaultId).toBe("blend-usdc-fixed");
  });

  it("skips reserves where the user has zero total balance", async () => {
    const reserveMap = new Map<string, object>([[USDC_ID, {}]]);
    const pool = makePool(reserveMap, {
      [USDC_ID]: { collateral: 0, supply: 0 },
    });
    vi.mocked(PoolV2.load).mockResolvedValue(pool as never);

    const result = await fetchBlendPositions(network, POOL_ID, PUBKEY, [
      reserves[0],
    ]);
    expect(result).toEqual([]);
  });
});


describe("BlendAdapterClient", () => {
  it("maps supply/withdraw to collateral request builders without hitting RPC", async () => {
    const { BlendAdapterClient } = await import("./blend");
    // prepareSorobanTx is exercised indirectly in integration; here we only
    // assert the client constructs and exposes the SDK surface.
    const client = new BlendAdapterClient({
      poolId: POOL_ID,
      assetId: USDC_ID,
      network,
    });
    expect(typeof client.supply).toBe("function");
    expect(typeof client.borrow).toBe("function");
    expect(typeof client.repay).toBe("function");
    expect(typeof client.withdraw).toBe("function");
    expect(typeof client.getHealthFactor).toBe("function");
    expect(typeof client.getPoolInfo).toBe("function");
    expect(typeof client.getUserPosition).toBe("function");
  });

  it("getHealthFactor returns Infinity when liabilities are zero", async () => {
    const { BlendAdapterClient } = await import("./blend");
    const reserveMap = new Map<string, object>([
      [USDC_ID, {}],
      [EURC_ID, {}],
    ]);
    const fakePool = {
      reserves: reserveMap,
      config: { backstopRate: 0.1 },
      loadUser: vi.fn(async () => ({
        getCollateralFloat: () => 100,
        getSupplyFloat: () => 0,
        getLiabilitiesFloat: () => 0,
      })),
    };
    vi.mocked(PoolV2.load).mockResolvedValue(fakePool as never);
    const client = new BlendAdapterClient({
      poolId: POOL_ID,
      assetId: USDC_ID,
      network,
    });
    await expect(client.getHealthFactor(PUBKEY, USDC_ID, USDC_ID)).resolves.toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("getHealthFactor divides collateral by liabilities", async () => {
    const { BlendAdapterClient } = await import("./blend");
    const reserveMap = new Map<string, object>([[USDC_ID, {}]]);
    const fakePool = {
      reserves: reserveMap,
      config: {},
      loadUser: vi.fn(async () => ({
        getCollateralFloat: () => 200,
        getSupplyFloat: () => 0,
        getLiabilitiesFloat: () => 50,
      })),
    };
    vi.mocked(PoolV2.load).mockResolvedValue(fakePool as never);
    const client = new BlendAdapterClient({
      poolId: POOL_ID,
      assetId: USDC_ID,
      network,
    });
    await expect(client.getHealthFactor(PUBKEY, USDC_ID, USDC_ID)).resolves.toBe(4);
  });
});
