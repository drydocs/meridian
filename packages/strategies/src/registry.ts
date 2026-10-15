import { SUPPORTED_STABLECOINS } from "@meridian/shared";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, PriceFeed } from "./types";
import { BuyAndHoldStrategy } from "./strategy";
import type { BuyAndHoldConfig, Strategy } from "./strategy";
import { DeltaNeutralStrategy } from "./delta-neutral";
import type { DeltaNeutralConfig } from "./delta-neutral";

/**
 * Runtime dependencies a scenario's string `params` cannot carry. Feeds come
 * from `scenario.source`, not from `strategy.params`, so the caller supplies
 * them and a definition that needs one rejects its absence.
 */
export interface StrategyDependencies {
  readonly priceFeed?: PriceFeed;
  readonly hedgeFeed?: PriceFeed;
}

export interface ResolvedStrategy<TConfig = unknown> {
  readonly strategy: Strategy<TConfig>;
  readonly config: TConfig;
}

/** What a definition author supplies: identity, constructor and params parser. */
export interface StrategyDefinitionSpec<TConfig = unknown> {
  readonly id: string;
  readonly version: string;
  create(): Strategy<TConfig>;
  /**
   * Turns the scenario's string params into a typed config. Must throw
   * `StrategyParamsError` on a missing, unknown or malformed value rather than
   * defaulting it.
   */
  parseParams(
    params: Readonly<Record<string, string>>,
    dependencies: StrategyDependencies
  ): TConfig;
}

/** A registered strategy, able to resolve itself to a strategy and config. */
export interface StrategyDefinition<
  TConfig = unknown,
> extends StrategyDefinitionSpec<TConfig> {
  /** Builds the strategy and parsed config for this exact id and version. */
  resolve(
    params: Readonly<Record<string, string>>,
    dependencies: StrategyDependencies
  ): ResolvedStrategy<TConfig>;
}

function defineStrategy<TConfig>(
  spec: StrategyDefinitionSpec<TConfig>
): StrategyDefinition<TConfig> {
  return {
    ...spec,
    resolve: (params, dependencies) => ({
      strategy: spec.create(),
      config: spec.parseParams(params, dependencies),
    }),
  };
}

/** Thrown when no registered definition matches an id and version. */
export class UnknownStrategyError extends Error {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly available: readonly string[];

  constructor(
    strategyId: string,
    strategyVersion: string,
    available: readonly string[]
  ) {
    super(
      `Unknown strategy '${strategyId}' version '${strategyVersion}'. ` +
        `Available: ${available.length > 0 ? available.join(", ") : "none"}.`
    );
    this.name = "UnknownStrategyError";
    this.strategyId = strategyId;
    this.strategyVersion = strategyVersion;
    this.available = available;
  }
}

export function isUnknownStrategyError(
  error: unknown
): error is UnknownStrategyError {
  return error instanceof UnknownStrategyError;
}

/** Thrown when a strategy's params block is missing or malformed. */
export class StrategyParamsError extends Error {
  readonly strategyId: string;
  readonly param: string;

  constructor(strategyId: string, param: string, message: string) {
    super(`Invalid param '${param}' for strategy '${strategyId}': ${message}`);
    this.name = "StrategyParamsError";
    this.strategyId = strategyId;
    this.param = param;
  }
}

export function isStrategyParamsError(
  error: unknown
): error is StrategyParamsError {
  return error instanceof StrategyParamsError;
}

// ---------------------------------------------------------------------------
// Param readers
// ---------------------------------------------------------------------------

type Params = Readonly<Record<string, string>>;

function rejectUnknownKeys(
  strategyId: string,
  params: Params,
  allowed: readonly string[]
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new StrategyParamsError(
        strategyId,
        key,
        `unknown param. Allowed: ${allowed.join(", ")}`
      );
    }
  }
}

function requireString(
  strategyId: string,
  params: Params,
  key: string
): string {
  const value = Object.prototype.hasOwnProperty.call(params, key)
    ? params[key]
    : undefined;
  if (value === undefined || value === "") {
    throw new StrategyParamsError(strategyId, key, "required but missing");
  }
  return value;
}

function readAsset(
  strategyId: string,
  params: Params,
  key: string
): AssetSymbol {
  const value = requireString(strategyId, params, key);
  if (!(SUPPORTED_STABLECOINS as readonly string[]).includes(value)) {
    throw new StrategyParamsError(
      strategyId,
      key,
      `'${value}' is not a supported asset. Allowed: ${SUPPORTED_STABLECOINS.join(", ")}`
    );
  }
  return value as AssetSymbol;
}

// At most seven fractional digits: `FixedPointDecimal.fromString` truncates
// anything finer, which would be a silent change to the stored value.
const DECIMAL_PATTERN = /^-?\d+(\.\d{1,7})?$/;

function readDecimal(
  strategyId: string,
  params: Params,
  key: string
): FixedPointDecimal {
  const value = requireString(strategyId, params, key);
  if (!DECIMAL_PATTERN.test(value)) {
    throw new StrategyParamsError(
      strategyId,
      key,
      `'${value}' is not a decimal string with at most 7 fractional digits`
    );
  }
  return FixedPointDecimal.fromString(value);
}

function readNonNegativeInteger(
  strategyId: string,
  params: Params,
  key: string
): number {
  const value = requireString(strategyId, params, key);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new StrategyParamsError(
      strategyId,
      key,
      `'${value}' is not a non-negative integer`
    );
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const BUY_AND_HOLD_ID = "buy-and-hold";
export const DELTA_NEUTRAL_ID = "delta-neutral";
export const STRATEGY_VERSION_1 = "1.0.0";

export const buyAndHoldDefinition = defineStrategy<BuyAndHoldConfig>({
  id: BUY_AND_HOLD_ID,
  version: STRATEGY_VERSION_1,
  create: () => new BuyAndHoldStrategy(),
  parseParams(params) {
    rejectUnknownKeys(BUY_AND_HOLD_ID, params, ["asset"]);
    return { asset: readAsset(BUY_AND_HOLD_ID, params, "asset") };
  },
});

export const deltaNeutralDefinition = defineStrategy<DeltaNeutralConfig>({
  id: DELTA_NEUTRAL_ID,
  version: STRATEGY_VERSION_1,
  create: () => new DeltaNeutralStrategy(),
  parseParams(params, dependencies) {
    rejectUnknownKeys(DELTA_NEUTRAL_ID, params, [
      "asset",
      "targetLeverage",
      "rebalanceBandBps",
      "fundingRatePerSecond",
    ]);
    const asset = readAsset(DELTA_NEUTRAL_ID, params, "asset");
    const targetLeverage = readDecimal(
      DELTA_NEUTRAL_ID,
      params,
      "targetLeverage"
    );
    if (targetLeverage.toStroops() <= 0n) {
      throw new StrategyParamsError(
        DELTA_NEUTRAL_ID,
        "targetLeverage",
        "must be strictly positive"
      );
    }
    const rebalanceBandBps = readNonNegativeInteger(
      DELTA_NEUTRAL_ID,
      params,
      "rebalanceBandBps"
    );
    const ratePerSecond = readDecimal(
      DELTA_NEUTRAL_ID,
      params,
      "fundingRatePerSecond"
    );
    if (!dependencies.priceFeed) {
      throw new StrategyParamsError(
        DELTA_NEUTRAL_ID,
        "priceFeed",
        "a price feed must be supplied through the dependencies argument"
      );
    }
    return {
      asset,
      targetLeverage,
      rebalanceBandBps,
      fundingRate: { ratePerSecond },
      priceFeed: dependencies.priceFeed,
      ...(dependencies.hedgeFeed ? { hedgeFeed: dependencies.hedgeFeed } : {}),
    };
  },
});

type RegisteredDefinition =
  StrategyDefinition<BuyAndHoldConfig> | StrategyDefinition<DeltaNeutralConfig>;

/** Definitions the package ships, in registration order. */
export const STRATEGY_DEFINITIONS: readonly RegisteredDefinition[] =
  Object.freeze([buyAndHoldDefinition, deltaNeutralDefinition]);

/**
 * Maps a scenario's `strategy.id` and `strategy.version` to a constructed
 * strategy and its parsed config.
 */
/* eslint-disable no-redeclare -- TypeScript overload signatures */
export function resolveStrategy(
  id: typeof BUY_AND_HOLD_ID,
  version: string,
  params: Readonly<Record<string, string>>,
  dependencies?: StrategyDependencies
): ResolvedStrategy<BuyAndHoldConfig>;
export function resolveStrategy(
  id: typeof DELTA_NEUTRAL_ID,
  version: string,
  params: Readonly<Record<string, string>>,
  dependencies?: StrategyDependencies
): ResolvedStrategy<DeltaNeutralConfig>;
export function resolveStrategy(
  id: string,
  version: string,
  params: Readonly<Record<string, string>>,
  dependencies?: StrategyDependencies
): ResolvedStrategy<BuyAndHoldConfig> | ResolvedStrategy<DeltaNeutralConfig>;
export function resolveStrategy(
  id: string,
  version: string,
  params: Readonly<Record<string, string>>,
  dependencies: StrategyDependencies = {}
): ResolvedStrategy<BuyAndHoldConfig> | ResolvedStrategy<DeltaNeutralConfig> {
  const definition = STRATEGY_DEFINITIONS.find(
    (d) => d.id === id && d.version === version
  );
  if (!definition) {
    throw new UnknownStrategyError(
      id,
      version,
      STRATEGY_DEFINITIONS.map((d) => `${d.id}@${d.version}`)
    );
  }
  return definition.resolve(params, dependencies);
}
/* eslint-enable no-redeclare */
