import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import {
  simulateView,
  type StellarNetwork,
} from "@meridian/stellar-sdk-helpers";
import { Decimal } from "./decimal";
import {
  FixedPointDecimal,
  UnknownAssetError,
  type AssetSymbol,
  type PriceFeed,
  type SimulationTimestamp,
} from "./types";

const ORACLE_TIMEOUT_MS = 8_000;
const DEFAULT_STALENESS_THRESHOLD_MS = 10 * 60 * 1000;
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Reflector encodes an `Asset` enum as `Stellar(Address)` or `Other(Symbol)`.
 * The caller names the variant directly, since a Stellar asset needs a contract
 * address that a symbol alone cannot supply.
 */
export type ReflectorAsset =
  { tag: "Stellar"; contractId: string } | { tag: "Other"; symbol: string };

/** A raw SEP-40 reading, before any scaling. */
export interface ReflectorOracleReading {
  /** Oracle price as an integer string, scaled by the oracle's `decimals`. */
  price: string;
  /** Unix seconds at which the oracle last updated this price. */
  updatedAtSeconds: string;
}

/** Injection seam so the feed can be exercised without network I/O. */
export interface ReflectorOracleClient {
  getDecimals(): Promise<number>;
  getLastPrice(asset: ReflectorAsset): Promise<ReflectorOracleReading | null>;
}

export class ReflectorOracleError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ReflectorOracleError";
    this.code = code;
  }
}

export class StaleOracleDataError extends ReflectorOracleError {
  readonly lastUpdate: Date;
  readonly thresholdMs: number;

  constructor(lastUpdate: Date, thresholdMs: number) {
    super(
      `Reflector oracle data is stale: last updated at ${lastUpdate.toISOString()}, threshold ${thresholdMs}ms`,
      "STALE_ORACLE_DATA"
    );
    this.name = "StaleOracleDataError";
    this.lastUpdate = lastUpdate;
    this.thresholdMs = thresholdMs;
  }
}

export class MissingOracleDataError extends ReflectorOracleError {
  readonly asset: AssetSymbol;

  constructor(asset: AssetSymbol) {
    super(
      `Reflector oracle returned no price for asset: ${asset}`,
      "MISSING_ORACLE_DATA"
    );
    this.name = "MissingOracleDataError";
    this.asset = asset;
  }
}

export interface ReflectorOraclePriceFeedOptions {
  network: StellarNetwork;
  /**
   * Reflector runs several feeds per network (DEX, external, fiat), each with
   * its own contract, so the caller selects one rather than relying on a default.
   */
  oracleContractId: string;
  assets: Partial<Record<AssetSymbol, ReflectorAsset>>;
  oracleClient?: ReflectorOracleClient;
  stalenessThresholdMs?: number;
  /** Clock seam, defaults to `Date.now`. */
  now?: () => number;
}

interface ReflectorPriceEntry {
  price: FixedPointDecimal;
  updatedAtMs: number;
}

export class StellarRpcReflectorOracleClient implements ReflectorOracleClient {
  readonly #network: StellarNetwork;
  readonly #contractId: string;
  readonly #server: rpc.Server;

  constructor(network: StellarNetwork, contractId: string) {
    this.#network = network;
    this.#contractId = contractId;
    this.#server = new rpc.Server(network.rpcUrl, {
      timeout: ORACLE_TIMEOUT_MS,
    });
  }

  async getDecimals(): Promise<number> {
    const result = await simulateView(
      this.#server,
      this.#contractId,
      this.#network.passphrase,
      "decimals"
    );
    return Number(result);
  }

  async getLastPrice(
    asset: ReflectorAsset
  ): Promise<ReflectorOracleReading | null> {
    const result = await simulateView(
      this.#server,
      this.#contractId,
      this.#network.passphrase,
      "lastprice",
      encodeReflectorAsset(asset)
    );
    return decodeReading(result);
  }
}

export function encodeReflectorAsset(asset: ReflectorAsset): xdr.ScVal {
  const variant = xdr.ScVal.scvSymbol(asset.tag);
  const payload =
    asset.tag === "Stellar"
      ? Address.fromString(asset.contractId).toScVal()
      : xdr.ScVal.scvSymbol(asset.symbol);
  return xdr.ScVal.scvVec([variant, payload]);
}

function decodeReading(result: unknown): ReflectorOracleReading | null {
  if (result === null || result === undefined) return null;
  if (typeof result !== "object") {
    throw new ReflectorOracleError(
      "Reflector oracle returned a lastprice value that is not a PriceData struct",
      "INVALID_PRICE_FORMAT"
    );
  }

  const { price, timestamp } = result as {
    price?: unknown;
    timestamp?: unknown;
  };
  const priceText = String(price);
  const updatedAtSeconds = String(timestamp);

  if (
    !INTEGER_PATTERN.test(priceText) ||
    !INTEGER_PATTERN.test(updatedAtSeconds)
  ) {
    throw new ReflectorOracleError(
      "Reflector oracle returned a PriceData struct with non-integer fields",
      "INVALID_PRICE_FORMAT"
    );
  }

  return { price: priceText, updatedAtSeconds };
}

export class ReflectorOraclePriceFeed implements PriceFeed {
  readonly #entries: ReadonlyMap<AssetSymbol, ReflectorPriceEntry>;
  readonly #stalenessThresholdMs: number;
  readonly #now: () => number;

  private constructor(
    entries: ReadonlyMap<AssetSymbol, ReflectorPriceEntry>,
    stalenessThresholdMs: number,
    now: () => number
  ) {
    this.#entries = entries;
    this.#stalenessThresholdMs = stalenessThresholdMs;
    this.#now = now;
  }

  /**
   * Reads every configured asset once and caches the result. `PriceFeed` reads
   * synchronously, so the network round trip has to happen here rather than in
   * `getSpotPrice`.
   */
  static async create(
    options: ReflectorOraclePriceFeedOptions
  ): Promise<ReflectorOraclePriceFeed> {
    const oracleClient =
      options.oracleClient ??
      new StellarRpcReflectorOracleClient(
        options.network,
        options.oracleContractId
      );

    const decimals = await oracleClient.getDecimals();
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ReflectorOracleError(
        `Reflector oracle reported an invalid decimals value: ${decimals}`,
        "INVALID_DECIMALS"
      );
    }

    const configured = Object.entries(options.assets).filter(
      (entry): entry is [AssetSymbol, ReflectorAsset] => entry[1] !== undefined
    );

    const entries = await Promise.all(
      configured.map(async ([asset, reflectorAsset]) => {
        const reading = await oracleClient.getLastPrice(reflectorAsset);
        if (!reading) {
          throw new MissingOracleDataError(asset);
        }

        return [
          asset,
          {
            price: FixedPointDecimal.fromStroops(
              new Decimal(BigInt(reading.price), decimals).toStroops()
            ),
            updatedAtMs: Number(reading.updatedAtSeconds) * 1000,
          },
        ] as const;
      })
    );

    return new ReflectorOraclePriceFeed(
      new Map(entries),
      options.stalenessThresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS,
      options.now ?? Date.now
    );
  }

  getSpotPrice(
    asset: AssetSymbol,
    _timestamp: SimulationTimestamp
  ): FixedPointDecimal {
    const entry = this.#entries.get(asset);
    if (!entry) {
      throw new UnknownAssetError(asset);
    }

    const ageMs = this.#now() - entry.updatedAtMs;
    if (ageMs > this.#stalenessThresholdMs) {
      throw new StaleOracleDataError(
        new Date(entry.updatedAtMs),
        this.#stalenessThresholdMs
      );
    }

    return entry.price;
  }
}
