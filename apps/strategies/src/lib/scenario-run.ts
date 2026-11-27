import {
  InvalidClockConfigError,
  KNOWN_ASSET_SYMBOLS,
  ScenarioValidationError,
  buildRegimeScenario,
  executeScenario,
  generateGbmPath,
  parseScenario,
  scenarioClock,
  seedToBigInt,
} from "@meridian/strategies";
import type {
  AssetSymbol,
  BacktestResult,
  HistoricalRow,
  MarketRegime,
  Scenario,
  ScenarioExecutionError,
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

export type ScenarioRunError = ScenarioExecutionError;

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

/**
 * Validates, resolves and runs one scenario against the synthetic market by
 * delegating end-to-end execution to {@link executeScenario}.
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

  const outcome = await executeScenario(scenario, {
    clock,
    historicalData: syntheticHistory(scenario, assets, clock, market),
    // An explicit empty pool list keeps the resolver off the network.
    defiLlamaPools: [],
  });

  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }

  return {
    ok: true,
    run: {
      scenario: outcome.value.scenario,
      market,
      result: outcome.value.result,
    },
  };
}
