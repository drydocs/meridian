import { runBacktest } from "./backtest";
import type { BacktestResult, ExecutionConfig } from "./backtest";
import { InvalidClockConfigError } from "./clock";
import type { SimulationClock } from "./clock";
import type { DeltaNeutralConfig } from "./delta-neutral";
import { scenarioClock } from "./regime-scenarios";
import {
  STRATEGY_DEFINITIONS,
  UnknownStrategyError,
  isStrategyParamsError,
  isUnknownStrategyError,
  resolveStrategy,
} from "./registry";
import type { ResolvedStrategy } from "./registry";
import { ScenarioValidationError, parseScenario } from "./scenario";
import type { Scenario } from "./scenario";
import {
  MissingSourceDataError,
  resolveScenarioSources,
} from "./scenario-sources";
import type {
  ResolveScenarioSourcesOptions,
  ResolvedScenarioSources,
} from "./scenario-sources";
import type { BuyAndHoldConfig } from "./strategy";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, PriceFeed } from "./types";

/** Options for end-to-end scenario execution. */
export interface ExecuteScenarioOptions extends ResolveScenarioSourcesOptions {
  /** Optional hedge price feed passed as a strategy dependency when required. */
  readonly hedgeFeed?: PriceFeed;
  /** Optional pre-built simulation clock; defaults to `scenarioClock(scenario)`. */
  readonly clock?: SimulationClock;
  /**
   * Execution cost and slippage configuration forwarded to `runBacktest`.
   * Defaults to the scenario's own cost schedule.
   */
  readonly execution?: ExecutionConfig;
}

export type ResolvedScenarioStrategy =
  ResolvedStrategy<BuyAndHoldConfig> | ResolvedStrategy<DeltaNeutralConfig>;

/** Resolved artifacts and backtest output for a completed scenario execution. */
export interface ScenarioExecutionResult {
  readonly scenario: Scenario;
  readonly strategy: ResolvedScenarioStrategy;
  readonly sources: ResolvedScenarioSources;
  readonly result: BacktestResult;
}

/** Typed failure union returned by {@link executeScenario}. */
export type ScenarioExecutionError =
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

export type ScenarioExecutionOutcome =
  | { readonly ok: true; readonly value: ScenarioExecutionResult }
  | { readonly ok: false; readonly error: ScenarioExecutionError };

function fromScenarioValidation(
  error: ScenarioValidationError
): ScenarioExecutionError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    fields[field] ??= `${field}: ${issue.message}`;
  }
  return { kind: "validation", message: error.message, fields };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runResolved<TConfig>(
  resolved: ResolvedStrategy<TConfig>,
  scenario: Scenario,
  clock: SimulationClock,
  sources: ResolvedScenarioSources,
  execution: ExecutionConfig | undefined
): BacktestResult {
  return runBacktest({
    clock,
    assets: scenario.assets as readonly AssetSymbol[],
    prices: sources.prices,
    strategy: resolved.strategy,
    strategyConfig: resolved.config,
    initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
    ...(sources.accrual ? { accrual: sources.accrual } : {}),
    ...(execution ? { execution } : {}),
  });
}

/**
 * Parses, resolves, and runs a scenario end to end.
 *
 * Accepts either an already-validated {@link Scenario} or unknown input.
 * Validation, unknown strategy/version, strategy parameter, and missing source
 * data errors are returned as typed {@link ScenarioExecutionError} values
 * before any backtest execution starts.
 */
export async function executeScenario(
  input: Scenario | unknown,
  options: ExecuteScenarioOptions = {}
): Promise<ScenarioExecutionOutcome> {
  let scenario: Scenario;
  try {
    scenario = parseScenario(input);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      return { ok: false, error: fromScenarioValidation(error) };
    }
    return {
      ok: false,
      error: { kind: "execution", message: errorMessage(error) },
    };
  }

  let clock: SimulationClock;
  try {
    clock = options.clock ?? scenarioClock(scenario);
  } catch (error) {
    if (error instanceof InvalidClockConfigError) {
      const message = `window.step: ${error.message}`;
      return {
        ok: false,
        error: {
          kind: "validation",
          message,
          fields: { "window.step": message },
        },
      };
    }
    return {
      ok: false,
      error: { kind: "execution", message: errorMessage(error) },
    };
  }

  // Fail fast on unknown strategy id/version before resolving sources.
  const isRegistered = STRATEGY_DEFINITIONS.some(
    (d) =>
      d.id === scenario.strategy.id && d.version === scenario.strategy.version
  );
  if (!isRegistered) {
    const err = new UnknownStrategyError(
      scenario.strategy.id,
      scenario.strategy.version,
      STRATEGY_DEFINITIONS.map((d) => `${d.id}@${d.version}`)
    );
    return {
      ok: false,
      error: {
        kind: "unknown-strategy",
        message: err.message,
        strategyId: err.strategyId,
        strategyVersion: err.strategyVersion,
        available: err.available,
      },
    };
  }

  try {
    const sources = await resolveScenarioSources(scenario, options);

    const strategy = resolveStrategy(
      scenario.strategy.id,
      scenario.strategy.version,
      scenario.strategy.params,
      {
        priceFeed: sources.prices,
        ...(options.hedgeFeed ? { hedgeFeed: options.hedgeFeed } : {}),
      }
    );

    // Every registered strategy trades a single `asset`, and the runner only
    // prices the scenario's assets, so an asset outside them would never fill.
    if (!scenario.assets.includes(strategy.config.asset)) {
      return {
        ok: false,
        error: {
          kind: "strategy-params",
          param: "asset",
          message: `Invalid param 'asset' for strategy '${scenario.strategy.id}': '${strategy.config.asset}' is not one of the scenario assets (${scenario.assets.join(", ")})`,
        },
      };
    }

    const result = runResolved(
      strategy,
      scenario,
      clock,
      sources,
      // Costs come from the scenario unless the caller overrides them.
      options.execution ?? sources.execution
    );
    return {
      ok: true,
      value: { scenario, strategy, sources, result },
    };
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
