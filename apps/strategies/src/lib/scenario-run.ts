import {
  FixedPointDecimal,
  InvalidClockConfigError,
  KNOWN_ASSET_SYMBOLS,
  MissingSourceDataError,
  ScenarioValidationError,
  buildRegimeScenario,
  generateGbmPath,
  parseScenario,
  resolveScenarioSources,
  resolveStrategy,
  runBacktest,
  scenarioClock,
  seedToBigInt,
  isStrategyParamsError,
  isUnknownStrategyError,
} from "@meridian/strategies";
import type {
  AssetSymbol,
  BacktestResult,
  HistoricalRow,
  MarketRegime,
  ResolvedStrategy,
  Scenario,
  SimulationClock,
} from "@meridian/strategies";

/**
 * Market model the in-app synthetic recording is generated from. The scenario
 * schema has no synthetic source, so the price path and cash rate live here
 * rather than in `strategy.params`, which the registry validates strictly.
 */
export interface SyntheticMarket {
  readonly regime: MarketRegime;
  readonly startPrice: string;
  /** Drift per step. */
  readonly drift: string;
  /** Volatility per step. */
  readonly volatility: string;
  /** Annualized cash rate recorded for the scenario's rate source. */
  readonly cashRateAnnual: string;
}

/** Everything a downstream view needs to render or replay a completed run. */
export interface ScenarioRun {
  readonly scenario: Scenario;
  readonly market: SyntheticMarket;
  readonly result: BacktestResult;
}

export type ScenarioRunError =
  | {
      readonly kind: "validation";
      readonly message: string;
      /** Field-qualified messages keyed by dot-joined path (`window.end`). */
      readonly fields: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "unknown-strategy";
      readonly message: string;
      readonly strategyId: string;
      readonly strategyVersion: string;
      readonly available: readonly string[];
    }
  | {
      readonly kind: "strategy-params";
      readonly message: string;
      readonly param: string;
    }
  | {
      readonly kind: "source";
      readonly message: string;
      readonly asset: string;
      readonly source: string;
    }
  | { readonly kind: "execution"; readonly message: string };

export type ScenarioRunOutcome =
  | { readonly ok: true; readonly run: ScenarioRun }
  | { readonly ok: false; readonly error: ScenarioRunError };

/**
 * Upper bound on ticks for one main-thread run. The built-in regimes use 24;
 * anything near this limit is a mistyped window or step, not a real request.
 */
export const MAX_SYNTHETIC_STEPS = 5_000;

const CASH_RATE_PATTERN = /^\d+(?:\.\d{1,7})?$/;

const REGIME_PARAM = {
  startPrice: "market.startPrice",
  drift: "market.drift",
  volatility: "market.volatility",
} as const;

/**
 * The price model of one engine regime scenario. Regime scenarios carry their
 * market inputs in `strategy.params`, which the registry rejects, so only the
 * market half is reused here and the strategy is configured by the form.
 */
export function regimeMarket(
  regime: MarketRegime,
  cashRateAnnual: string
): SyntheticMarket {
  const params = buildRegimeScenario(regime).strategy.params;
  const read = (key: string): string => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`regime scenario '${regime}' is missing "${key}"`);
    }
    return value;
  };
  return {
    regime,
    startPrice: read(REGIME_PARAM.startPrice),
    drift: read(REGIME_PARAM.drift),
    volatility: read(REGIME_PARAM.volatility),
    cashRateAnnual,
  };
}

/**
 * A recorded-data stand-in for the scenario's declared sources: one seeded GBM
 * path per asset and a flat rate stream for the rate source, both on the
 * scenario's own clock. Feeding it through `resolveScenarioSources` keeps the
 * app on the same resolution path a real recording would take.
 */
export function syntheticHistory(
  scenario: Scenario,
  assets: readonly AssetSymbol[],
  clock: SimulationClock,
  market: SyntheticMarket
): HistoricalRow[] {
  const rows: HistoricalRow[] = [];
  for (const asset of assets) {
    const path = generateGbmPath({
      startPrice: market.startPrice,
      drift: market.drift,
      volatility: market.volatility,
      steps: clock.stepCount,
      seed: seedToBigInt(`${scenario.seed}:${asset}`),
    });
    path.forEach((price, index) => {
      rows.push({
        asset,
        timestamp: clock.timestampAt(index),
        price: price.toString(),
        kind: "price",
      });
    });
  }
  for (let index = 0; index <= clock.stepCount; index += 1) {
    rows.push({
      asset: scenario.source.rate,
      timestamp: clock.timestampAt(index),
      rate: market.cashRateAnnual,
      kind: "rate",
    });
  }
  return rows;
}

function validationError(fields: Record<string, string>): ScenarioRunError {
  return {
    kind: "validation",
    message: Object.values(fields).join("; "),
    fields,
  };
}

function fromScenarioValidation(
  error: ScenarioValidationError
): ScenarioRunError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    fields[field] ??= `${field}: ${issue.message}`;
  }
  return { kind: "validation", message: error.message, fields };
}

const KNOWN_ASSETS: readonly string[] = KNOWN_ASSET_SYMBOLS;

function isAssetSymbol(value: string): value is AssetSymbol {
  return KNOWN_ASSETS.includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execute<TConfig>(
  resolved: ResolvedStrategy<TConfig>,
  scenario: Scenario,
  assets: readonly AssetSymbol[],
  clock: SimulationClock,
  sources: Awaited<ReturnType<typeof resolveScenarioSources>>
): BacktestResult {
  // The scenario schema has no cost schedule yet, so execution runs at the
  // runner's zero-cost default until the cost-schedule work adds one.
  return runBacktest({
    clock,
    assets,
    prices: sources.prices,
    strategy: resolved.strategy,
    strategyConfig: resolved.config,
    initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
    ...(sources.accrual ? { accrual: sources.accrual } : {}),
  });
}

/**
 * Validates, resolves and runs one scenario against the synthetic market.
 *
 * This is the app's only run-assembly path, so an engine-level scenario
 * execution facade can replace its body without touching the views. Every
 * failure is returned as a typed {@link ScenarioRunError} instead of thrown.
 */
export async function runScenario(
  input: unknown,
  market: SyntheticMarket
): Promise<ScenarioRunOutcome> {
  let scenario: Scenario;
  try {
    scenario = parseScenario(input);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      return { ok: false, error: fromScenarioValidation(error) };
    }
    throw error;
  }

  if (!CASH_RATE_PATTERN.test(market.cashRateAnnual)) {
    return {
      ok: false,
      error: validationError({
        "market.cashRateAnnual":
          "market.cashRateAnnual: must be a non-negative decimal fraction with at most 7 decimal places (e.g. 0.05)",
      }),
    };
  }

  const unsupported = scenario.assets.filter((asset) => !isAssetSymbol(asset));
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: validationError({
        assets: `assets: no synthetic price model for ${unsupported.join(", ")}. Supported: ${KNOWN_ASSETS.join(", ")}`,
      }),
    };
  }
  const assets = scenario.assets.filter(isAssetSymbol);

  let clock: SimulationClock;
  try {
    clock = scenarioClock(scenario);
  } catch (error) {
    if (error instanceof InvalidClockConfigError) {
      return {
        ok: false,
        error: validationError({
          "window.step": `window.step: ${error.message}`,
        }),
      };
    }
    throw error;
  }
  if (clock.stepCount > MAX_SYNTHETIC_STEPS) {
    return {
      ok: false,
      error: validationError({
        "window.step": `window.step: the window spans ${clock.stepCount} steps; at most ${MAX_SYNTHETIC_STEPS} are supported`,
      }),
    };
  }

  try {
    const sources = await resolveScenarioSources(scenario, {
      historicalData: syntheticHistory(scenario, assets, clock, market),
      // An explicit empty pool list keeps the resolver off the network.
      defiLlamaPools: [],
    });

    const resolved = resolveStrategy(
      scenario.strategy.id,
      scenario.strategy.version,
      scenario.strategy.params,
      { priceFeed: sources.prices }
    );

    // Every registered strategy trades a single `asset`, and the runner only
    // prices the scenario's assets, so an asset outside them would never fill.
    if (!(assets as readonly string[]).includes(resolved.config.asset)) {
      return {
        ok: false,
        error: {
          kind: "strategy-params",
          param: "asset",
          message: `Invalid param 'asset' for strategy '${scenario.strategy.id}': '${resolved.config.asset}' is not one of the scenario assets (${assets.join(", ")})`,
        },
      };
    }

    const result = execute(resolved, scenario, assets, clock, sources);
    return { ok: true, run: { scenario, market, result } };
  } catch (error) {
    if (isUnknownStrategyError(error)) {
      return {
        ok: false,
        error: {
          kind: "unknown-strategy",
          message: error.message,
          strategyId: error.strategyId,
          strategyVersion: error.strategyVersion,
          available: error.available,
        },
      };
    }
    if (isStrategyParamsError(error)) {
      return {
        ok: false,
        error: {
          kind: "strategy-params",
          message: error.message,
          param: error.param,
        },
      };
    }
    if (error instanceof MissingSourceDataError) {
      return {
        ok: false,
        error: {
          kind: "source",
          message: error.message,
          asset: error.asset,
          source: error.source,
        },
      };
    }
    return {
      ok: false,
      error: { kind: "execution", message: errorMessage(error) },
    };
  }
}
