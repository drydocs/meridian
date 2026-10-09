import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  blendAssetForVault,
  fetchBlendPositions,
  buildBlendDepositTx,
  buildBlendWithdrawTx,
  BlendAdapterClient,
  type BlendPoolConfig,
} from "./blend";
import { prepareSorobanTx } from "./tx";
import type { StellarNetwork } from "./types";

// `submit` is the wire-level call the tx builders make; hoisted so the SDK mock
// below can expose it and the assertions can inspect every request it receives.
const { submitMock } = vi.hoisted(() => ({
  submitMock: vi.fn((..._args: unknown[]) => "AAAAFAKEOPERATIONXDR"),
}));

// Mock the Blend SDK so fetchBlendPositions never touches the network.
vi.mock("@blend-capital/blend-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@blend-capital/blend-sdk")>();
  return {
    ...actual,
    PoolV2: {
      load: vi.fn(),
    },
    // Only `submit` is exercised; every request it receives is recorded so the
    // builders can be asserted at the SDK boundary.
    PoolContractV2: class {
      constructor(readonly poolId: string) {}

      submit(...args: unknown[]): string {
        return submitMock(...args);
      }
    },
  };
});

// `prepareSorobanTx` simulates + assembles against a real RPC, so the tx
// builders are asserted up to the operation boundary and the assembler is
// stubbed. Its real behaviour is covered where it lives (`tx.test.ts`).
vi.mock("./tx", () => ({
  prepareSorobanTx: vi.fn(async () => ({ xdr: "AAAA=PREPARED", fee: "100" })),
}));

// Keep the rest of the SDK intact and replace only the XDR decoder, so no real
// operation has to be constructed to drive the builder.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    xdr: {
      ...actual.xdr,
      Operation: {
        ...actual.xdr.Operation,
        fromXDR: vi.fn(() => ({ decodedOperation: true })),
      },
    },
  };
});

import { PoolV2, RequestType } from "@blend-capital/blend-sdk";

const network: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const POOL_ID = "CPOOL0000000000000000000000000000000000000000000000000000";
const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ID = "CUSDC0000000000000000000000000000000000000000000000000000";
const EURC_ID = "CEURC0000000000000000000000000000000000000000000000000000";

const config: BlendPoolConfig = { poolId: POOL_ID, assetId: USDC_ID, network };

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

describe("Blend transaction builders", () => {
  it("submits a supply-collateral request and returns the prepared transaction", async () => {
    submitMock.mockClear();

    await expect(buildBlendDepositTx(config, PUBKEY, 1_000n)).resolves.toEqual({
      xdr: "AAAA=PREPARED",
      fee: "100",
    });

    expect(submitMock).toHaveBeenCalledWith({
      from: PUBKEY,
      spender: PUBKEY,
      to: PUBKEY,
      requests: [
        {
          request_type: RequestType.SupplyCollateral,
          address: USDC_ID,
          amount: 1_000n,
        },
      ],
    });
    expect(prepareSorobanTx).toHaveBeenCalledWith(network, PUBKEY, {
      decodedOperation: true,
    });
  });

  it("submits a withdraw-collateral request for the withdraw path", async () => {
    submitMock.mockClear();

    await buildBlendWithdrawTx(config, PUBKEY, 500n);

    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [
          {
            request_type: RequestType.WithdrawCollateral,
            address: USDC_ID,
            amount: 500n,
          },
        ],
      })
    );
  });

  it("rejects a non-positive amount before it reaches the SDK", async () => {
    submitMock.mockClear();

    await expect(buildBlendDepositTx(config, PUBKEY, 0n)).rejects.toThrow(
      /amount must be positive/i
    );
    expect(submitMock).not.toHaveBeenCalled();
    expect(prepareSorobanTx).not.toHaveBeenCalled();
  });
});

describe("BlendAdapterClient", () => {
  const client = new BlendAdapterClient(config);

  it.each([
    ["supply", RequestType.SupplyCollateral],
    ["borrow", RequestType.Borrow],
    ["repay", RequestType.Repay],
    ["withdraw", RequestType.WithdrawCollateral],
  ] as const)(
    "%s maps to a %s request for the named asset",
    async (method, requestType) => {
      submitMock.mockClear();

      await client[method](EURC_ID, 42n, PUBKEY);

      expect(submitMock).toHaveBeenCalledWith({
        from: PUBKEY,
        spender: PUBKEY,
        to: PUBKEY,
        requests: [
          { request_type: requestType, address: EURC_ID, amount: 42n },
        ],
      });
    }
  );

  it.each([
    ["supply", RequestType.SupplyCollateral],
    ["borrow", RequestType.Borrow],
    ["repay", RequestType.Repay],
    ["withdraw", RequestType.WithdrawCollateral],
  ] as const)(
    "%s falls back to the configured reserve when the caller passes no asset",
    async (method, requestType) => {
      submitMock.mockClear();

      await client[method]("", 7n, PUBKEY);

      expect(submitMock).toHaveBeenCalledWith({
        from: PUBKEY,
        spender: PUBKEY,
        to: PUBKEY,
        requests: [
          {
            request_type: requestType,
            address: USDC_ID,
            amount: 7n,
          },
        ],
      });
    }
  );

  it("getHealthFactor returns Infinity when liabilities are zero", async () => {
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

    await expect(
      client.getHealthFactor(PUBKEY, USDC_ID, USDC_ID)
    ).resolves.toBe(Number.POSITIVE_INFINITY);
  });

  it("getHealthFactor divides collateral by liabilities", async () => {
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

    await expect(
      client.getHealthFactor(PUBKEY, USDC_ID, USDC_ID)
    ).resolves.toBe(4);
  });

  it("getHealthFactor treats an unknown reserve as a zero balance", async () => {
    vi.mocked(PoolV2.load).mockResolvedValue({
      reserves: new Map<string, object>(),
      loadUser: vi.fn(async () => ({
        getCollateralFloat: () => 99,
        getSupplyFloat: () => 0,
        getLiabilitiesFloat: () => 9,
      })),
    } as never);

    await expect(
      client.getHealthFactor(PUBKEY, USDC_ID, EURC_ID)
    ).resolves.toBe(Number.POSITIVE_INFINITY);
  });

  it("getPoolInfo reports the reserve set and the backstop rate", async () => {
    const reserveMap = new Map<string, object>([
      [USDC_ID, {}],
      [EURC_ID, {}],
    ]);
    vi.mocked(PoolV2.load).mockResolvedValue({
      reserves: reserveMap,
      metadata: { backstopRate: 123456n },
    } as never);

    await expect(client.getPoolInfo()).resolves.toEqual({
      poolId: POOL_ID,
      backstopRate: 123456,
      reserveCount: 2,
      reserves: [USDC_ID, EURC_ID],
    });

    // The default pool id is overridable for multi-pool callers.
    await expect(client.getPoolInfo("COTHERPOOL")).resolves.toMatchObject({
      poolId: "COTHERPOOL",
    });
  });

  it("getUserPosition buckets only the non-zero balances", async () => {
    const usdcReserve = { id: "usdc" };
    const eurcReserve = { id: "eurc" };
    const reserveMap = new Map<string, object>([
      [USDC_ID, usdcReserve],
      [EURC_ID, eurcReserve],
    ]);
    vi.mocked(PoolV2.load).mockResolvedValue({
      reserves: reserveMap,
      loadUser: vi.fn(async () => ({
        getCollateralFloat: (reserve: object) =>
          reserve === usdcReserve ? 12 : 0,
        getLiabilitiesFloat: (reserve: object) =>
          reserve === eurcReserve ? 4 : 0,
        getSupplyFloat: (reserve: object) => (reserve === usdcReserve ? 3 : 0),
      })),
    } as never);

    await expect(client.getUserPosition(PUBKEY)).resolves.toEqual({
      account: PUBKEY,
      poolId: POOL_ID,
      collateral: { [USDC_ID]: 12 },
      liabilities: { [EURC_ID]: 4 },
      supply: { [USDC_ID]: 3 },
    });
  });
});
