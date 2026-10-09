import { SUPPORTED_STABLECOINS } from "@meridian/shared";

import { SimulationClock } from "./clock";
import type { DeltaNeutralConfig } from "./delta-neutral";
import { BacktestPriceFeed } from "./feeds";
import { generateGbmPath } from "./gbm";
import {
  durationToMilliseconds,
  millisecondsToDuration,
  parseScenario,
  toIsoInstant,
} from "./scenario";
import type { Scenario } from "./scenario";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, FundingRate, PriceFeed } from "./types";

/**
 * Synthetic market regimes for scenario backtests (#932).
 *
 * A regime is a validated {@link Scenario}. Its window, asset, capital, strategy
 * identity and seed are the scenario's own fields, and the market parameters the
 * price path is generated from ride in `strategy.params`, which the schema
 * declares as fixed-point decimal strings. A run is reproducible from the
 * scenario alone, with no float in the path.
 *
 * `source.price` is recorded as `horizon` because the schema's source field
 * selects a data origin and has no synthetic option. These scenarios read from
 * no source, their prices come from {@link scenarioPriceFeed}.
 */

/** The market regimes #932 covers. */
export const MARKET_REGIMES = ["trending", "ranging", "high-funding"] as const;
export type MarketRegime = (typeof MARKET_REGIMES)[number];

/**
 * Market parameters carried in `strategy.params`, namespaced to keep them clear
 * of a strategy's own knobs.
 */
const PARAM = {
  regime: "market.regime",
  startPrice: "market.startPrice",
  drift: "market.drift",
  volatility: "market.volatility",
  fundingRatePerSecond: "market.fundingRatePerSecond",
  neutralityBandBps: "market.neutralityBandBps",
  targetLeverage: "market.targetLeverage",
} as const;

interface RegimeParameters {
  readonly startPrice: string;
  /** Drift per step, in the same units as the step. */
  readonly drift: string;
  /** Volatility per step. */
  readonly volatility: string;
  /** Funding paid on the short hedge, per second. */
  readonly fundingRatePerSecond: string;
}

/**
 * The funding rates sit above `1e-7`, the smallest value the seven-decimal
 * fixed point holds, since anything finer truncates to zero and stops accruing.
 * Real perpetual funding is finer per second, so these rates are exaggerated.
 * They drive the strategy's carry across regimes rather than mirror a venue.
 */
const REGIME_PARAMETERS: Record<MarketRegime, RegimeParameters> = {
  trending: {
    startPrice: "1",
    drift: "0.0015",
    volatility: "0.004",
    fundingRatePerSecond: "0.0000003",
  },
  ranging: {
    startPrice: "1",
    drift: "0",
    volatility: "0.006",
    fundingRatePerSecond: "0.0000001",
  },
  "high-funding": {
    startPrice: "1",
    drift: "0.0001",
    volatility: "0.002",
    fundingRatePerSecond: "0.000001",
  },
};

export const DEFAULT_REGIME_ASSET: AssetSymbol = "USDC";
export const DEFAULT_REGIME_CAPITAL = "10000";
export const DEFAULT_REGIME_STEPS = 24;
export const DEFAULT_REGIME_STEP_MS = 3_600_000;
export const DEFAULT_REGIME_START_MS = 1_700_000_000_000;
export const DEFAULT_REGIME_NEUTRALITY_BAND_BPS = 50;
export const DEFAULT_REGIME_TARGET_LEVERAGE = "2";

export interface RegimeScenarioOptions {
  readonly asset?: AssetSymbol;
  readonly seed?: string;
  readonly capital?: string;
  readonly steps?: number;
  readonly stepMs?: number;
  readonly startMs?: number;
  readonly neutralityBandBps?: number;
  readonly targetLeverage?: string;
  /** Overrides the regime's own generated market parameters. */
  readonly market?: Partial<RegimeParameters>;
}

/**
 * Deterministic 64-bit seed for a scenario's string seed (FNV-1a). The schema
 * requires a non-empty string, and the path generator takes a `bigint`, so the
 * mapping has to be total rather than assuming the seed is numeric.
 */
export function seedToBigInt(seed: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= BigInt(seed.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & ((1n << 64n) - 1n);
  }
  return hash;
}

/**
 * Builds the validated scenario for one market regime. Throws
 * `ScenarioValidationError` if an override makes the scenario invalid, which is
 * what keeps the returned value a legal input to a run.
 */
export function buildRegimeScenario(
  regime: MarketRegime,
  options: RegimeScenarioOptions = {}
): Scenario {
  const steps = options.steps ?? DEFAULT_REGIME_STEPS;
  const stepMs = options.stepMs ?? DEFAULT_REGIME_STEP_MS;
  const startMs = options.startMs ?? DEFAULT_REGIME_START_MS;
  const market = { ...REGIME_PARAMETERS[regime], ...options.market };

  return parseScenario({
    window: {
      start: toIsoInstant(startMs),
      end: toIsoInstant(startMs + steps * stepMs),
      step: millisecondsToDuration(stepMs),
    },
    assets: [options.asset ?? DEFAULT_REGIME_ASSET],
    source: { price: "horizon", rate: "blend" },
    startingCapital: options.capital ?? DEFAULT_REGIME_CAPITAL,
    strategy: {
      id: "delta-neutral",
      version: "1",
      params: {
        [PARAM.regime]: regime,
        [PARAM.startPrice]: market.startPrice,
        [PARAM.drift]: market.drift,
        [PARAM.volatility]: market.volatility,
        [PARAM.fundingRatePerSecond]: market.fundingRatePerSecond,
        [PARAM.neutralityBandBps]: String(
          options.neutralityBandBps ?? DEFAULT_REGIME_NEUTRALITY_BAND_BPS
        ),
        [PARAM.targetLeverage]:
          options.targetLeverage ?? DEFAULT_REGIME_TARGET_LEVERAGE,
      },
    },
    seed: options.seed ?? "932",
  });
}

function param(scenario: Scenario, key: string): string {
  const value = scenario.strategy.params[key];
  if (value === undefined) {
    throw new Error(`scenario strategy.params is missing "${key}"`);
  }
  return value;
}

/**
 * The asset a scenario's run trades. The scenario schema types `assets` as
 * free-form strings while everything downstream prices through `AssetSymbol`,
 * so the first entry is narrowed here rather than asserted.
 */
function scenarioAsset(scenario: Scenario): AssetSymbol {
  const asset = scenario.assets[0];
  if (asset === undefined || !isAssetSymbol(asset)) {
    throw new Error(`unsupported scenario asset: ${String(asset)}`);
  }
  return asset;
}

function isAssetSymbol(value: string): value is AssetSymbol {
  return (SUPPORTED_STABLECOINS as readonly string[]).includes(value);
}

/** The scenario's window and step as a simulation clock. */
export function scenarioClock(scenario: Scenario): SimulationClock {
  return new SimulationClock({
    start: Date.parse(scenario.window.start),
    end: Date.parse(scenario.window.end),
    stepMs: durationToMilliseconds(scenario.window.step),
  });
}

/**
 * The scenario's price path, one point per clock tick, served through a
 * `BacktestPriceFeed`. Generated by the shared GBM path model from the
 * scenario's seed, so an identical scenario always yields an identical feed.
 */
export function scenarioPriceFeed(scenario: Scenario): BacktestPriceFeed {
  const clock = scenarioClock(scenario);
  const asset = scenarioAsset(scenario);
  const path = generateGbmPath({
    startPrice: param(scenario, PARAM.startPrice),
    drift: param(scenario, PARAM.drift),
    volatility: param(scenario, PARAM.volatility),
    steps: clock.stepCount,
    seed: seedToBigInt(scenario.seed),
  });

  // The feed takes every supported asset, and a regime run only reads the one
  // the scenario names, so the other series is registered empty.
  const series: Record<
    AssetSymbol,
    Array<{ timestamp: number; price: FixedPointDecimal }>
  > = { USDC: [], EURC: [] };
  series[asset] = path.map((price, index) => ({
    timestamp: clock.timestampAt(index),
    price,
  }));

  return BacktestPriceFeed.create(series);
}

/** The per-second funding rate the scenario's strategy params declare. */
export function scenarioFundingRate(scenario: Scenario): FundingRate {
  return {
    ratePerSecond: FixedPointDecimal.fromString(
      param(scenario, PARAM.fundingRatePerSecond)
    ),
  };
}

/** The delta-neutral configuration the scenario describes, priced by `prices`. */
export function scenarioDeltaNeutralConfig(
  scenario: Scenario,
  prices: PriceFeed
): DeltaNeutralConfig {
  return {
    id: `${scenario.strategy.id}:${param(scenario, PARAM.regime)}`,
    asset: scenarioAsset(scenario),
    targetLeverage: FixedPointDecimal.fromString(
      param(scenario, PARAM.targetLeverage)
    ),
    rebalanceBandBps: Number(param(scenario, PARAM.neutralityBandBps)),
    fundingRate: scenarioFundingRate(scenario),
    priceFeed: prices,
  };
}
