import { describe, it, expect, vi, beforeEach } from "vitest";
import { Address } from "@stellar/stellar-sdk";
import { simulateView } from "@meridian/stellar-sdk-helpers";
import {
  ReflectorOraclePriceFeed,
  ReflectorOracleError,
  StaleOracleDataError,
  MissingOracleDataError,
  StellarRpcReflectorOracleClient,
  encodeReflectorAsset,
  type ReflectorAsset,
  type ReflectorOracleClient,
  type ReflectorOracleReading,
} from "./reflector-oracle-price-feed";
import {
  FixedPointDecimal,
  UnknownAssetError,
  type AssetSymbol,
  type PriceFeed,
  type SimulationTimestamp,
} from "./types";
import type { StellarNetwork } from "@meridian/stellar-sdk-helpers";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  simulateView: vi.fn(),
}));

const simulateViewMock = vi.mocked(simulateView);

const NETWORK: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const ORACLE_CONTRACT_ID =
  "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
// Stellar Asset Contract for Circle's mainnet USDC.
const USDC_CONTRACT_ID =
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const USDC_ASSET: ReflectorAsset = {
  tag: "Stellar",
  contractId: USDC_CONTRACT_ID,
};
const EURC_ASSET: ReflectorAsset = { tag: "Other", symbol: "EUR" };

const UPDATED_AT_SECONDS = 1_700_000_000;
const UPDATED_AT_MS = UPDATED_AT_SECONDS * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const NOW_MS = UPDATED_AT_MS + 60_000;
const TIMESTAMP: SimulationTimestamp = UPDATED_AT_MS;

class StubReflectorOracleClient implements ReflectorOracleClient {
  decimals = 8;
  readonly requested: ReflectorAsset[] = [];
  readonly #readings = new Map<string, ReflectorOracleReading | null>();

  setReading(
    asset: ReflectorAsset,
    reading: ReflectorOracleReading | null
  ): void {
    this.#readings.set(JSON.stringify(asset), reading);
  }

  async getDecimals(): Promise<number> {
    return this.decimals;
  }

  async getLastPrice(
    asset: ReflectorAsset
  ): Promise<ReflectorOracleReading | null> {
    this.requested.push(asset);
    return this.#readings.get(JSON.stringify(asset)) ?? null;
  }
}

function reading(price: string): ReflectorOracleReading {
  return { price, updatedAtSeconds: String(UPDATED_AT_SECONDS) };
}

async function createFeed(
  client: StubReflectorOracleClient,
  overrides: {
    assets?: Partial<Record<AssetSymbol, ReflectorAsset>>;
    stalenessThresholdMs?: number;
    now?: () => number;
  } = {}
): Promise<PriceFeed> {
  return ReflectorOraclePriceFeed.create({
    network: NETWORK,
    oracleContractId: ORACLE_CONTRACT_ID,
    oracleClient: client,
    assets: overrides.assets ?? { USDC: USDC_ASSET, EURC: EURC_ASSET },
    now: overrides.now ?? (() => NOW_MS),
    ...(overrides.stalenessThresholdMs !== undefined
      ? { stalenessThresholdMs: overrides.stalenessThresholdMs }
      : {}),
  });
}

describe("ReflectorOraclePriceFeed precision", () => {
  let client: StubReflectorOracleClient;

  beforeEach(() => {
    client = new StubReflectorOracleClient();
    simulateViewMock.mockReset();
  });

  it("scales the oracle reading into FixedPointDecimal stroops exactly", async () => {
    client.decimals = 8;
    client.setReading(USDC_ASSET, reading("100000000"));
    client.setReading(EURC_ASSET, reading("108000000"));

    const feed = await createFeed(client);

    const usdc = feed.getSpotPrice("USDC", TIMESTAMP);
    expect(usdc).toBeInstanceOf(FixedPointDecimal);
    expect(usdc.toStroops()).toBe(10_000_000n);
    expect(usdc.toString()).toBe("1");
    expect(feed.getSpotPrice("EURC", TIMESTAMP).toString()).toBe("1.08");
  });

  it("scales up exactly when the oracle reports fewer decimals than a stroop", async () => {
    client.decimals = 2;
    client.setReading(USDC_ASSET, reading("150"));

    const feed = await createFeed(client, { assets: { USDC: USDC_ASSET } });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(15_000_000n);
  });

  it("rescales at a finer oracle precision instead of dropping to a float", async () => {
    client.decimals = 14;
    client.setReading(USDC_ASSET, reading("100000000000000"));

    const feed = await createFeed(client, { assets: { USDC: USDC_ASSET } });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(10_000_000n);
  });

  it("rounds half-up when the oracle precision exceeds the stroop scale", async () => {
    client.decimals = 14;
    client.setReading(USDC_ASSET, reading("100000005000000"));

    const feed = await createFeed(client, { assets: { USDC: USDC_ASSET } });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(10_000_001n);
  });

  it("keeps integers that a JavaScript number could not represent", async () => {
    client.decimals = 0;
    client.setReading(USDC_ASSET, reading("9007199254740993"));

    const feed = await createFeed(client, { assets: { USDC: USDC_ASSET } });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(
      9007199254740993n * 10_000_000n
    );
  });

  it("reads every configured asset once and does not re-query per price read", async () => {
    client.setReading(USDC_ASSET, reading("100000000"));
    client.setReading(EURC_ASSET, reading("108000000"));

    const feed = await createFeed(client);
    feed.getSpotPrice("USDC", TIMESTAMP);
    feed.getSpotPrice("EURC", TIMESTAMP);

    expect(client.requested).toEqual([USDC_ASSET, EURC_ASSET]);
  });
});

describe("ReflectorOraclePriceFeed staleness", () => {
  let client: StubReflectorOracleClient;

  beforeEach(() => {
    client = new StubReflectorOracleClient();
    client.setReading(USDC_ASSET, reading("100000000"));
  });

  it("throws StaleOracleDataError once the reading ages past the threshold", async () => {
    const feed = await createFeed(client, {
      assets: { USDC: USDC_ASSET },
      stalenessThresholdMs: TEN_MINUTES_MS,
      now: () => UPDATED_AT_MS + TEN_MINUTES_MS + 1,
    });

    expect(() => feed.getSpotPrice("USDC", TIMESTAMP)).toThrow(
      StaleOracleDataError
    );

    try {
      feed.getSpotPrice("USDC", TIMESTAMP);
    } catch (error) {
      expect(error).toBeInstanceOf(ReflectorOracleError);
      const stale = error as StaleOracleDataError;
      expect(stale.code).toBe("STALE_ORACLE_DATA");
      expect(stale.lastUpdate.getTime()).toBe(UPDATED_AT_MS);
      expect(stale.thresholdMs).toBe(TEN_MINUTES_MS);
    }
  });

  it("serves a reading exactly at the threshold boundary", async () => {
    const feed = await createFeed(client, {
      assets: { USDC: USDC_ASSET },
      stalenessThresholdMs: TEN_MINUTES_MS,
      now: () => UPDATED_AT_MS + TEN_MINUTES_MS,
    });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(10_000_000n);
  });

  it("defaults the threshold to ten minutes", async () => {
    const feed = await createFeed(client, {
      assets: { USDC: USDC_ASSET },
      now: () => UPDATED_AT_MS + TEN_MINUTES_MS - 1,
    });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(10_000_000n);
  });

  it("defaults the clock to the current time", async () => {
    client.setReading(USDC_ASSET, {
      price: "100000000",
      updatedAtSeconds: String(Math.floor(Date.now() / 1000)),
    });

    const feed = await ReflectorOraclePriceFeed.create({
      network: NETWORK,
      oracleContractId: ORACLE_CONTRACT_ID,
      oracleClient: client,
      assets: { USDC: USDC_ASSET },
    });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(10_000_000n);
  });
});

describe("ReflectorOraclePriceFeed typed errors", () => {
  let client: StubReflectorOracleClient;

  beforeEach(() => {
    client = new StubReflectorOracleClient();
  });

  it("throws MissingOracleDataError when the oracle has no price for a configured asset", async () => {
    client.setReading(USDC_ASSET, null);

    await expect(
      createFeed(client, { assets: { USDC: USDC_ASSET } })
    ).rejects.toThrow(MissingOracleDataError);

    client.setReading(USDC_ASSET, null);
    await expect(
      createFeed(client, { assets: { USDC: USDC_ASSET } })
    ).rejects.toMatchObject({
      code: "MISSING_ORACLE_DATA",
      asset: "USDC",
    });
  });

  it("throws UnknownAssetError for an asset outside the configured set", async () => {
    client.setReading(USDC_ASSET, reading("100000000"));
    const feed = await createFeed(client, { assets: { USDC: USDC_ASSET } });

    expect(() => feed.getSpotPrice("EURC", TIMESTAMP)).toThrow(
      UnknownAssetError
    );
  });

  it("throws on an oracle decimals value that cannot be a scale", async () => {
    client.decimals = -1;
    client.setReading(USDC_ASSET, reading("100000000"));

    await expect(
      createFeed(client, { assets: { USDC: USDC_ASSET } })
    ).rejects.toMatchObject({ code: "INVALID_DECIMALS" });

    client.decimals = 1.5;
    await expect(
      createFeed(client, { assets: { USDC: USDC_ASSET } })
    ).rejects.toMatchObject({ code: "INVALID_DECIMALS" });
  });
});

describe("encodeReflectorAsset", () => {
  it("encodes a Stellar asset as the Stellar variant carrying an address", () => {
    const encoded = encodeReflectorAsset(USDC_ASSET);
    const vec = encoded.vec();

    expect(vec).not.toBeNull();
    expect(vec![0]!.sym().toString()).toBe("Stellar");
    expect(Address.fromScVal(vec![1]!).toString()).toBe(USDC_CONTRACT_ID);
  });

  it("encodes a non-Stellar asset as the Other variant carrying a symbol", () => {
    const encoded = encodeReflectorAsset(EURC_ASSET);
    const vec = encoded.vec();

    expect(vec).not.toBeNull();
    expect(vec![0]!.sym().toString()).toBe("Other");
    expect(vec![1]!.sym().toString()).toBe("EUR");
  });
});

describe("StellarRpcReflectorOracleClient", () => {
  let client: StellarRpcReflectorOracleClient;

  beforeEach(() => {
    simulateViewMock.mockReset();
    client = new StellarRpcReflectorOracleClient(NETWORK, ORACLE_CONTRACT_ID);
  });

  it("reads decimals through a simulated view call", async () => {
    simulateViewMock.mockResolvedValue(8);

    await expect(client.getDecimals()).resolves.toBe(8);
    expect(simulateViewMock).toHaveBeenCalledWith(
      expect.anything(),
      ORACLE_CONTRACT_ID,
      NETWORK.passphrase,
      "decimals"
    );
  });

  it("decodes a PriceData struct into integer strings", async () => {
    simulateViewMock.mockResolvedValue({
      price: 100000000n,
      timestamp: BigInt(UPDATED_AT_SECONDS),
    });

    await expect(client.getLastPrice(USDC_ASSET)).resolves.toEqual({
      price: "100000000",
      updatedAtSeconds: String(UPDATED_AT_SECONDS),
    });
  });

  it("returns null when the oracle holds no price for the asset", async () => {
    simulateViewMock.mockResolvedValue(null);

    await expect(client.getLastPrice(USDC_ASSET)).resolves.toBeNull();
  });

  it("throws when the simulated result is not a PriceData struct", async () => {
    simulateViewMock.mockResolvedValue("not-a-struct");

    await expect(client.getLastPrice(USDC_ASSET)).rejects.toMatchObject({
      code: "INVALID_PRICE_FORMAT",
    });
  });

  it("throws when the PriceData fields cannot be read as integers", async () => {
    simulateViewMock.mockResolvedValue({ price: 1n });

    await expect(client.getLastPrice(USDC_ASSET)).rejects.toMatchObject({
      code: "INVALID_PRICE_FORMAT",
    });
  });

  it("is built by default when no client is injected", async () => {
    simulateViewMock.mockImplementation(
      async (_server, _contractId, _passphrase, method) =>
        method === "decimals"
          ? 8
          : { price: 100000000n, timestamp: BigInt(UPDATED_AT_SECONDS) }
    );

    const feed = await ReflectorOraclePriceFeed.create({
      network: NETWORK,
      oracleContractId: ORACLE_CONTRACT_ID,
      assets: { USDC: USDC_ASSET },
      now: () => NOW_MS,
    });

    expect(feed.getSpotPrice("USDC", TIMESTAMP).toStroops()).toBe(10_000_000n);
  });
});

describe("ReflectorOraclePriceFeed isolation guard", () => {
  it("exposes no write, submit or signing surface", () => {
    const writeLike = /submit|sign|write|send|transfer|invoke|deploy/i;
    const members = [
      ...Object.getOwnPropertyNames(ReflectorOraclePriceFeed.prototype),
      ...Object.getOwnPropertyNames(ReflectorOraclePriceFeed),
      ...Object.getOwnPropertyNames(StellarRpcReflectorOracleClient.prototype),
    ];

    for (const member of members) {
      expect(member).not.toMatch(writeLike);
    }
  });

  it("performs only simulated view calls", async () => {
    simulateViewMock.mockReset();
    simulateViewMock.mockResolvedValue(null);
    const client = new StellarRpcReflectorOracleClient(
      NETWORK,
      ORACLE_CONTRACT_ID
    );

    await client.getLastPrice(USDC_ASSET);

    expect(simulateViewMock).toHaveBeenCalledTimes(1);
  });
});
