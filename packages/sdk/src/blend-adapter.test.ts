import { Contract, xdr } from "@stellar/stellar-sdk";
import {
  ReserveConfigV2,
  ReserveData,
  ReserveV2,
  type Pool,
  type PoolUser,
  type Reserve,
} from "@blend-capital/blend-sdk";
import { describe, expect, it, vi } from "vitest";
import type { StellarNetwork } from "@meridian/stellar-sdk-helpers";
import { BlendAdapterClient, type BlendAdapterDeps } from "./blend-adapter.js";
import {
  MalformedPoolResponseError,
  TimeoutError,
  UnsupportedError,
  ValidationError,
} from "./errors.js";

const NETWORK: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://rpc.example",
  passphrase: "Test SDF Network ; September 2015",
};

// Real, checksum-valid contract ids: `new Contract(...)` validates the StrKey
// checksum, so a run of repeated letters would fail in buildAccrueTx.
const ADAPTER = "CAIQBVLBIUWQGE6DQUHDMZ2QWI7QP6KTCN7GP2BIZ6JZC4ES47JO4SSM";
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const EURC = "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV";
const CALLER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

type Simulate = NonNullable<BlendAdapterDeps["simulate"]>;
type Prepare = NonNullable<BlendAdapterDeps["prepare"]>;
type LoadPool = NonNullable<BlendAdapterDeps["loadPool"]>;

function simulateReturning(
  values: Record<string, unknown | (() => unknown)>
): Simulate {
  return vi.fn(
    async (
      _server: unknown,
      _contractId: string,
      _passphrase: string,
      method: string
    ) => {
      if (!(method in values)) return null;
      const value = values[method];
      const resolved =
        typeof value === "function" && !(value instanceof Error)
          ? (value as () => unknown)()
          : value;
      if (resolved instanceof Error) throw resolved;
      return resolved;
    }
  ) as unknown as Simulate;
}

function reserveFixture(
  params: {
    assetId?: string;
    curUtil?: number;
    rBase?: number;
  } = {}
): ReserveV2 {
  const SCALE_7 = 10_000_000;
  const config = new ReserveConfigV2(
    0,
    7,
    0,
    0,
    Math.round(0.8 * SCALE_7),
    SCALE_7,
    Math.round((params.rBase ?? 0.01) * SCALE_7),
    Math.round(0.04 * SCALE_7),
    Math.round(0.5 * SCALE_7),
    Math.round(1.5 * SCALE_7),
    0,
    0n,
    true
  );
  const bSupply = 1_000_000_0000000n;
  const curUtil = params.curUtil ?? 0.7;
  const dSupply = BigInt(Math.round(curUtil * 1_000_000)) * 10_000_000n;
  const RATE_SCALE_12 = 1_000_000_000_000n;
  const data = new ReserveData(
    RATE_SCALE_12,
    RATE_SCALE_12,
    10_000_000n,
    dSupply,
    bSupply,
    0n,
    0
  );
  const reserve = new ReserveV2(
    POOL,
    params.assetId ?? USDC,
    config,
    data,
    undefined,
    undefined,
    0,
    0,
    0,
    0,
    0
  );
  reserve.setRates(1_000_000n);
  return reserve;
}

function poolFixture(
  overrides: {
    reserves?: Map<string, Reserve>;
    loadUser?: (account: string) => Promise<PoolUser>;
  } = {}
): Pool {
  return {
    id: POOL,
    reserves: overrides.reserves ?? new Map([[USDC, reserveFixture()]]),
    loadUser: overrides.loadUser ?? (async () => userFixture({})),
  } as unknown as Pool;
}

function userFixture(values: {
  collateral?: bigint;
  supply?: bigint;
  liabilities?: bigint;
  byAsset?: Record<
    string,
    { collateral?: bigint; supply?: bigint; liabilities?: bigint }
  >;
}): PoolUser {
  return {
    getCollateral: (reserve: Reserve) =>
      values.byAsset?.[reserve.assetId]?.collateral ?? values.collateral ?? 0n,
    getSupply: (reserve: Reserve) =>
      values.byAsset?.[reserve.assetId]?.supply ?? values.supply ?? 0n,
    getLiabilities: (reserve: Reserve) =>
      values.byAsset?.[reserve.assetId]?.liabilities ??
      values.liabilities ??
      0n,
  } as unknown as PoolUser;
}

function makeClient(
  deps: BlendAdapterDeps = {},
  config: Partial<ConstructorParameters<typeof BlendAdapterClient>[0]> = {}
): BlendAdapterClient {
  return new BlendAdapterClient(
    { adapterId: ADAPTER, network: NETWORK, ...config },
    deps
  );
}

describe("BlendAdapterClient construction", () => {
  it("rejects an adapter id that is not a contract address", () => {
    expect(
      () => new BlendAdapterClient({ adapterId: "nope", network: NETWORK })
    ).toThrow(ValidationError);
  });

  it("rejects non-positive timeout overrides", () => {
    expect(() => makeClient({}, { timeouts: { operationMs: -1 } })).toThrow(
      ValidationError
    );
  });

  it("exposes the configured adapter id", () => {
    expect(makeClient().adapterId).toBe(ADAPTER);
  });
});

describe("BlendAdapterClient discovery", () => {
  it("resolves the pool and protocol for a configured adapter", async () => {
    const simulate = simulateReturning({
      get_protocol: "blend",
      get_pool: POOL,
    });

    const info = await makeClient({ simulate }).discover();

    expect(info).toEqual({
      adapterId: ADAPTER,
      protocol: "blend",
      poolId: POOL,
    });
    expect(simulate).toHaveBeenCalledWith(
      expect.anything(),
      ADAPTER,
      NETWORK.passphrase,
      "get_protocol"
    );
    expect(simulate).toHaveBeenCalledWith(
      expect.anything(),
      ADAPTER,
      NETWORK.passphrase,
      "get_pool"
    );
  });

  it("reports an unconfigured adapter as a typed UnsupportedError", async () => {
    const simulate = simulateReturning({
      get_protocol: "blend",
      get_pool: new Error("Error(Contract, #3)"),
    });

    const client = makeClient({ simulate });

    await expect(client.getPool()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(client.getPool()).rejects.toThrow(/no pool configured/);
  });

  it("lets an unrelated get_pool failure keep its own classification", async () => {
    const simulate = simulateReturning({
      get_pool: new Error("fetch failed"),
    });

    const client = makeClient({ simulate });

    await expect(client.getPool()).rejects.toThrow("fetch failed");
  });

  it("rejects a get_pool response that is not a contract address", async () => {
    const simulate = simulateReturning({ get_pool: "not-a-contract" });

    const client = makeClient({ simulate });

    await expect(client.getPool()).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
  });

  it("rejects a non-string get_pool response", async () => {
    const simulate = simulateReturning({ get_pool: 42n });

    const client = makeClient({ simulate });

    await expect(client.getPool()).rejects.toThrow(
      /instead of a contract address/
    );
  });

  it("rejects a get_protocol response that is not a name", async () => {
    const simulate = simulateReturning({ get_protocol: null });

    const client = makeClient({ simulate });

    await expect(client.getProtocol()).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
  });

  it("returns the protocol string", async () => {
    const simulate = simulateReturning({ get_protocol: "blend" });

    await expect(makeClient({ simulate }).getProtocol()).resolves.toBe("blend");
  });
});

describe("BlendAdapterClient totals and reserves", () => {
  it("returns the adapter's cached total assets as a bigint", async () => {
    const simulate = simulateReturning({ total_assets: 12_345n });

    await expect(makeClient({ simulate }).getTotalAssets()).resolves.toBe(
      12_345n
    );
  });

  it("rejects a total_assets response that is not an integer amount", async () => {
    const simulate = simulateReturning({ total_assets: 12345 });

    await expect(
      makeClient({ simulate }).getTotalAssets()
    ).rejects.toBeInstanceOf(MalformedPoolResponseError);
  });

  it("returns typed reserve data for the adapter's pool", async () => {
    const reserve = reserveFixture();
    const loadPool = vi.fn(async () =>
      poolFixture({ reserves: new Map([[USDC, reserve]]) })
    );
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: loadPool as unknown as LoadPool,
    });

    const info = await client.getReserve(USDC);

    expect(loadPool).toHaveBeenCalledWith(NETWORK, POOL);
    expect(info).toMatchObject({
      poolId: POOL,
      assetId: USDC,
      index: 0,
      decimals: 7,
      supplyApr: reserve.supplyApr,
      supplyApy: reserve.estSupplyApy,
      supplyApyBps: Math.round(reserve.estSupplyApy * 10_000),
      borrowApr: reserve.borrowApr,
      borrowApy: reserve.estBorrowApy,
      utilization: reserve.getUtilizationFloat(),
    });
    expect(info.totalSupply).toBe(
      reserve.toAssetFromBToken(reserve.data.bSupply)
    );
    expect(info.totalBorrows).toBe(
      reserve.toAssetFromDToken(reserve.data.dSupply)
    );
  });

  it("returns the supply APY in rounded basis points", async () => {
    const reserve = reserveFixture();
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () =>
        poolFixture({ reserves: new Map([[USDC, reserve]]) })) as LoadPool,
    });

    await expect(client.getSupplyApy(USDC)).resolves.toBe(
      Math.round(reserve.estSupplyApy * 10_000)
    );
  });

  it("rejects a reserve the pool does not carry", async () => {
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () => poolFixture()) as LoadPool,
    });

    await expect(client.getReserve(EURC)).rejects.toBeInstanceOf(
      UnsupportedError
    );
  });

  it("rejects a loaded pool whose reserve table is missing", async () => {
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () =>
        ({ id: POOL, reserves: undefined }) as unknown as Pool) as LoadPool,
    });

    await expect(client.getReserve(USDC)).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
  });

  it("rejects a reserve missing its rate fields", async () => {
    const malformed = {
      poolId: POOL,
      assetId: USDC,
      config: { index: 0, decimals: 7 },
    } as unknown as Reserve;
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () =>
        poolFixture({ reserves: new Map([[USDC, malformed]]) })) as LoadPool,
    });

    await expect(client.getReserve(USDC)).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
  });

  it("requires a contract address for assetId", async () => {
    await expect(makeClient().getReserve("usdc")).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(makeClient().getSupplyApy("usdc")).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

describe("BlendAdapterClient positions", () => {
  it("returns typed positions for reserves the account touches", async () => {
    const reserves = new Map<string, Reserve>([
      [USDC, reserveFixture({ assetId: USDC })],
      [EURC, reserveFixture({ assetId: EURC })],
    ]);
    const user = userFixture({
      byAsset: {
        [USDC]: { collateral: 500n, supply: 100n, liabilities: 25n },
        [EURC]: { collateral: 0n, supply: 0n, liabilities: 0n },
      },
    });
    const loadUser = vi.fn(async () => user);
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () => poolFixture({ reserves, loadUser })) as LoadPool,
    });

    const positions = await client.getPositions(CALLER);

    expect(loadUser).toHaveBeenCalledWith(CALLER);
    expect(positions).toEqual([
      {
        poolId: POOL,
        assetId: USDC,
        index: 0,
        collateral: 500n,
        supply: 100n,
        liabilities: 25n,
        total: 600n,
      },
    ]);
  });

  it("returns an empty array for an account with no position", async () => {
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () => poolFixture()) as LoadPool,
    });

    await expect(client.getPositions(CALLER)).resolves.toEqual([]);
  });

  it("rejects a malformed user position", async () => {
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () =>
        poolFixture({ loadUser: async () => ({}) as PoolUser })) as LoadPool,
    });

    await expect(client.getPositions(CALLER)).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
  });

  it("rejects a pool without loadUser", async () => {
    const client = makeClient({
      simulate: simulateReturning({ get_pool: POOL }),
      loadPool: (async () =>
        ({ id: POOL, reserves: new Map() }) as unknown as Pool) as LoadPool,
    });

    await expect(client.getPositions(CALLER)).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
  });

  it("requires an account", async () => {
    await expect(makeClient().getPositions("")).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

describe("BlendAdapterClient accrue transaction", () => {
  it("builds an unsigned accrue transaction for a Blend adapter", async () => {
    const prepare = vi.fn(async () => ({ xdr: "AAAA", fee: "100" }));
    const client = makeClient(
      {
        simulate: simulateReturning({
          get_protocol: "blend",
          get_pool: POOL,
        }),
        prepare: prepare as unknown as Prepare,
      },
      { retry: { maxAttempts: 2, baseDelayMs: 0, retryTxBuilders: true } }
    );

    await expect(client.buildAccrueTx(CALLER)).resolves.toEqual({
      xdr: "AAAA",
      fee: "100",
    });

    const [network, caller, op] = prepare.mock.calls[0] as unknown as [
      StellarNetwork,
      string,
      xdr.Operation,
    ];
    expect(network).toBe(NETWORK);
    expect(caller).toBe(CALLER);
    expect(op.toXDR("base64")).toBe(
      new Contract(ADAPTER).call("accrue").toXDR("base64")
    );
  });

  it("refuses to build accrue for a non-Blend adapter", async () => {
    const prepare = vi.fn();
    const client = makeClient({
      simulate: simulateReturning({ get_protocol: "defindex" }),
      prepare: prepare as unknown as Prepare,
    });

    await expect(client.buildAccrueTx(CALLER)).rejects.toBeInstanceOf(
      UnsupportedError
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires a caller", async () => {
    await expect(makeClient().buildAccrueTx("")).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});

describe("BlendAdapterClient policies and hooks", () => {
  it("retries a retryable read per the configured policy", async () => {
    let calls = 0;
    const simulate = simulateReturning({
      total_assets: () => {
        calls += 1;
        if (calls === 1) throw new Error("fetch failed");
        return 7n;
      },
    });

    const client = makeClient(
      { simulate },
      { retry: { maxAttempts: 2, baseDelayMs: 0, jitter: false } }
    );

    await expect(client.getTotalAssets()).resolves.toBe(7n);
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("enforces the per-operation time budget", async () => {
    const simulate = simulateReturning({
      total_assets: () => new Promise(() => undefined),
    });
    const client = makeClient({ simulate }, { timeouts: { operationMs: 5 } });

    await expect(client.getTotalAssets()).rejects.toBeInstanceOf(TimeoutError);
  });

  it("reports success and failure through instrumentation hooks", async () => {
    const onRequestStart = vi.fn();
    const onRequestSuccess = vi.fn();
    const onRequestError = vi.fn();
    const hooks = { onRequestStart, onRequestSuccess, onRequestError };

    const ok = makeClient(
      { simulate: simulateReturning({ total_assets: 1n }) },
      { hooks }
    );
    await ok.getTotalAssets();

    expect(onRequestStart).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "getTotalAssets", attempt: 1 })
    );
    expect(onRequestSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "getTotalAssets" })
    );

    const bad = makeClient(
      { simulate: simulateReturning({ get_pool: "bad" }) },
      { hooks }
    );
    await expect(bad.getPool()).rejects.toBeInstanceOf(
      MalformedPoolResponseError
    );
    expect(onRequestError).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "getPool" })
    );
  });
});
