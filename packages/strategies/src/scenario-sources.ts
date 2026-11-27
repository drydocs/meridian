/**
 * Scenario price and rate sources resolver (#1025).
 *
 * Connects Scenario declarative sources ({ price: "horizon" | "defillama", rate: "blend" | "defindex" })
 * and windows with the concrete PriceFeed and AccrualConfig required by runBacktest.
 *
 * Code standard: NO network call occurs at module load time.
 */

import { BacktestPriceFeed, type BacktestPriceFeedOptions } from "./feeds";
import {
  FixedPointDecimal,
  type AssetSymbol,
  type BacktestPricePoint,
  type PriceFeed,
} from "./types";
import {
  durationToMilliseconds,
  scenarioCostSchedule,
  type Scenario,
} from "./scenario";
import {
  loadHistoricalSeries,
  type HistoricalInput,
  type LoadedStream,
} from "./historical-loader";
import type { AccrualConfig, ExecutionConfig } from "./backtest/runner";
import type { DefiLlamaPool } from "@meridian/stellar-sdk-helpers";
import { isRegimeScenario, scenarioPriceFeed } from "./regime-scenarios";

/**
 * Thrown when a declared price or rate source does not contain data covering
 * the scenario's window for a required asset.
 */
export class MissingSourceDataError extends Error {
  readonly asset: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly source: string;

  constructor(params: {
    asset: string;
    window: { start: string; end: string };
    source: string;
    message?: string;
  }) {
    const msg =
      params.message ??
      `No data available for asset "${params.asset}" across window ${params.window.start} to ${params.window.end} from source "${params.source}"`;
    super(msg);
    this.name = "MissingSourceDataError";
    this.asset = params.asset;
    this.window = params.window;
    this.source = params.source;
    Object.setPrototypeOf(this, MissingSourceDataError.prototype);
  }
}

/**
 * Concrete feeds and configuration resolved from a scenario.
 */
export interface ResolvedScenarioSources {
  readonly prices: PriceFeed;
  readonly hedgePrices?: PriceFeed;
  readonly accrual?: AccrualConfig;
  readonly execution: ExecutionConfig;
}

/**
 * Options configuring scenario sources resolution.
 */
export interface ResolveScenarioSourcesOptions {
  /**
   * Pre-recorded historical rows or stream map (per #865).
   * Used for "horizon" and "defillama" recorded prices and protocol rate streams.
   */
  readonly historicalData?: HistoricalInput;

  /**
   * Optional custom loader for DeFiLlama pools.
   * If omitted and pools are required, dynamically invokes getStellarStablecoinPools() on demand.
   */
  readonly fetchDeFiLlamaPools?: () => Promise<DefiLlamaPool[]>;

  /**
   * Optional manual pools list for DeFiLlama to bypass live network entirely.
   * An explicit empty array `[]` will be respected and will not trigger live network calls.
   */
  readonly defiLlamaPools?: readonly DefiLlamaPool[];

  /**
   * Cadence in milliseconds for pricing points. If omitted, derived from scenario.window.step.
   */
  readonly intervalMs?: number;

  /**
   * Scale for fixed-point parsing. Defaults to 7.
   */
  readonly scale?: number;

  /**
   * Whether the returned BacktestPriceFeed requires exact timestamp hits (strict mode).
   */
  readonly strict?: boolean;
}

/**
 * Resolves a scenario's declared price and rate sources into a concrete
 * PriceFeed and AccrualConfig ready for runBacktest.
 *
 * Guarantees:
 * 1. Deterministic output for identical scenario inputs and data.
 * 2. Strict validation: throws MissingSourceDataError naming asset and window if data is absent.
 * 3. Lazy network access: zero network calls happen at module load time.
 * 4. High precision: cash accrual maintains annualized rate to avoid zero-truncation.
 */
export async function resolveScenarioSources(
  scenario: Scenario,
  options: ResolveScenarioSourcesOptions = {}
): Promise<ResolvedScenarioSources> {
  if (
    isRegimeScenario(scenario) &&
    scenario.source.price === "horizon" &&
    options.historicalData === undefined &&
    options.defiLlamaPools === undefined &&
    options.fetchDeFiLlamaPools === undefined
  ) {
    return {
      prices: scenarioPriceFeed(scenario),
      execution: { costSchedule: scenarioCostSchedule(scenario) },
    };
  }

  const windowStartMs = Date.parse(scenario.window.start);
  const windowEndMs = Date.parse(scenario.window.end);
  const stepMs =
    options.intervalMs ?? durationToMilliseconds(scenario.window.step);
  const scale = options.scale ?? 7;

  // 1. Load any supplied historical input via the #865 loader
  let loadedSeries: Record<string, LoadedStream> = {};
  if (options.historicalData) {
    loadedSeries = loadHistoricalSeries(options.historicalData, {
      intervalMs: stepMs,
      scale,
      onOutOfOrder: "sort",
      onDuplicate: "last",
    });
  }

  // 2. Resolve the spot and (optional) hedge price feeds. Both come from
  // recorded series supplied in `historicalData`, so they share one builder.
  const feedOptions: BacktestPriceFeedOptions | undefined =
    options.strict !== undefined ? { strict: options.strict } : undefined;

  /**
   * Builds a feed from the loaded series, one per scenario asset. A series
   * must exist and span the whole scenario window, otherwise the run fails
   * before it starts with a MissingSourceDataError.
   */
  const buildFeed = (
    kind: "price" | "hedge",
    source: string,
    seriesKeys: (asset: string) => readonly string[]
  ): PriceFeed => {
    const prefix = kind === "hedge" ? "hedge " : "";
    const feedMap = new Map<AssetSymbol, BacktestPricePoint[]>();

    for (const asset of scenario.assets) {
      const stream = seriesKeys(asset)
        .map((key) => loadedSeries[key])
        .find((candidate) => candidate !== undefined);

      if (!stream || stream.series.points.length === 0) {
        throw new MissingSourceDataError({
          asset,
          window: { start: scenario.window.start, end: scenario.window.end },
          source,
          message: `${source} ${prefix}price data missing for asset "${asset}" across window ${scenario.window.start} to ${scenario.window.end}`,
        });
      }

      // Ensure real price points fully cover the scenario window
      const points = stream.series.points;
      const minTimestamp = points[0]!.timestampMs;
      const maxTimestamp = points[points.length - 1]!.timestampMs;

      if (minTimestamp > windowStartMs || maxTimestamp < windowEndMs) {
        throw new MissingSourceDataError({
          asset,
          window: { start: scenario.window.start, end: scenario.window.end },
          source,
          message: `${source} ${prefix}recorded series for asset "${asset}" covers ${new Date(minTimestamp).toISOString()} to ${new Date(maxTimestamp).toISOString()}, which does not fully span scenario window ${scenario.window.start} to ${scenario.window.end}`,
        });
      }

      feedMap.set(
        asset as AssetSymbol,
        points.map((p) => ({
          timestamp: p.timestampMs,
          price: FixedPointDecimal.fromString(p.value.toString()),
        }))
      );
    }

    return new BacktestPriceFeed(feedMap, feedOptions);
  };

  let priceFeed: PriceFeed;
  const priceSource = scenario.source.price;

  if (priceSource === "horizon" || priceSource === "defillama") {
    // Both horizon and defillama price sources require real price observations (#1025).
    // Spot series are named "price:<asset>", "<asset>" or "price:<ASSET>".
    priceFeed = buildFeed("price", priceSource, (asset) => [
      `price:${asset}`,
      asset,
      `price:${asset.toUpperCase()}`,
    ]);
  } else {
    throw new Error(`Unsupported price source: ${priceSource}`);
  }

  // The hedge leg's prices are read from price rows whose `asset` is
  // "hedge:<asset>" in `historicalData` (the loader names that series
  // "price:hedge:<asset>"), one per scenario asset, with the same loader and
  // the same window coverage rules as the spot series. No loader or synthetic history
  // produces them yet, so a scenario that declares `source.hedge` must be
  // given those series by its caller; without them the run fails before it
  // starts with a MissingSourceDataError.
  let hedgeFeed: PriceFeed | undefined;
  const hedgeSource = scenario.source.hedge;

  if (hedgeSource !== undefined) {
    if (hedgeSource === "horizon" || hedgeSource === "defillama") {
      hedgeFeed = buildFeed("hedge", hedgeSource, (asset) => [
        `price:hedge:${asset}`,
      ]);
    } else {
      throw new Error(`Unsupported hedge source: ${hedgeSource}`);
    }
  }

  // 3. Resolve Rate Source & Accrual Config
  const rateSource = scenario.source.rate;
  let accrualConfig: AccrualConfig | undefined;

  // Search loaded historical rate streams
  let ratePointDecimal: FixedPointDecimal | undefined;

  // Check rate streams in order: "rate:<source>", "rate:<source>:<asset>", "<source>", etc.
  for (const key of Object.keys(loadedSeries)) {
    if (
      key === `rate:${rateSource}` ||
      key.startsWith(`rate:${rateSource}:`) ||
      key === rateSource
    ) {
      const stream = loadedSeries[key];
      if (stream && stream.series.points.length > 0) {
        const points = stream.series.points;
        const minTimestamp = points[0]!.timestampMs;
        const maxTimestamp = points[points.length - 1]!.timestampMs;

        // Verify that rate stream covers the scenario window
        if (minTimestamp > windowStartMs || maxTimestamp < windowEndMs) {
          const targetAsset = scenario.assets[0] ?? "USDC";
          throw new MissingSourceDataError({
            asset: targetAsset,
            window: { start: scenario.window.start, end: scenario.window.end },
            source: rateSource,
            message: `Rate recorded series for source "${rateSource}" covers ${new Date(minTimestamp).toISOString()} to ${new Date(maxTimestamp).toISOString()}, which does not fully span scenario window ${scenario.window.start} to ${scenario.window.end}`,
          });
        }

        ratePointDecimal = FixedPointDecimal.fromString(
          points[0]!.value.toString()
        );
        break;
      }
    }
  }

  // If rate data was found from historical series, configure accrual without touching pool network
  if (ratePointDecimal) {
    accrualConfig = {
      cashRateAnnual: ratePointDecimal,
    };
  } else {
    // Check DeFiLlama pool APY if available
    let pools: readonly DefiLlamaPool[];
    if (options.defiLlamaPools !== undefined) {
      pools = options.defiLlamaPools;
    } else if (options.fetchDeFiLlamaPools) {
      pools = await options.fetchDeFiLlamaPools();
    } else {
      // Lazy import to guarantee zero module-load network calls
      const { getStellarStablecoinPools } =
        await import("@meridian/stellar-sdk-helpers");
      pools = await getStellarStablecoinPools();
    }

    const pool = pools.find(
      (p) =>
        p.project.toLowerCase() === rateSource.toLowerCase() ||
        p.symbol.toUpperCase() === rateSource.toUpperCase()
    );

    if (pool && typeof pool.apy === "number") {
      const annualFraction = (pool.apy / 100).toFixed(7);
      const annualDecimal = FixedPointDecimal.fromString(annualFraction);
      accrualConfig = {
        cashRateAnnual: annualDecimal,
      };
    }
  }

  // If no rate data found for declared source
  if (!accrualConfig) {
    const targetAsset = scenario.assets[0] ?? "USDC";
    throw new MissingSourceDataError({
      asset: targetAsset,
      window: { start: scenario.window.start, end: scenario.window.end },
      source: rateSource,
      message: `No rate data available for source "${rateSource}" across window ${scenario.window.start} to ${scenario.window.end}`,
    });
  }

  return {
    prices: priceFeed,
    ...(hedgeFeed ? { hedgePrices: hedgeFeed } : {}),
    accrual: accrualConfig,
    execution: { costSchedule: scenarioCostSchedule(scenario) },
  };
}
