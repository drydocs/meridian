import {
  BUY_AND_HOLD_ID,
  DELTA_NEUTRAL_ID,
  MARKET_REGIMES,
  STRATEGY_DEFINITIONS,
  buildRegimeScenario,
} from "@meridian/strategies";
import type { MarketRegime } from "@meridian/strategies";
import { regimeMarket } from "./scenario-run";
import type { SyntheticMarket } from "./scenario-run";

/** Raw, editable form state. Every field is a string until `parseScenario`. */
export interface ScenarioFormValues {
  readonly regime: MarketRegime;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly windowStep: string;
  /** Comma-separated asset symbols. */
  readonly assets: string;
  readonly priceSource: string;
  readonly rateSource: string;
  readonly startingCapital: string;
  readonly seed: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  /** Params of a strategy listed in {@link STRATEGY_PARAM_FIELDS}. */
  readonly params: Readonly<Record<string, string>>;
  /** `key=value` lines for a registered strategy without param labels. */
  readonly paramsText: string;
  readonly cashRateAnnual: string;
}

export interface StrategyParamField {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
}

/**
 * Labels for the params of the strategies the app knows how to describe. The
 * registry exposes ids and versions but not a param schema, so a strategy
 * registered without an entry here falls back to a free-form params editor.
 */
export const STRATEGY_PARAM_FIELDS: Readonly<
  Record<string, readonly StrategyParamField[]>
> = {
  [BUY_AND_HOLD_ID]: [
    { key: "asset", label: "Asset", hint: "One of the scenario assets" },
  ],
  [DELTA_NEUTRAL_ID]: [
    { key: "asset", label: "Asset", hint: "One of the scenario assets" },
    {
      key: "targetLeverage",
      label: "Target leverage",
      hint: "Decimal, greater than zero",
    },
    {
      key: "rebalanceBandBps",
      label: "Rebalance band (bps)",
      hint: "Non-negative integer",
    },
    {
      key: "fundingRatePerSecond",
      label: "Funding rate per second",
      hint: "Signed decimal, at most 7 places",
    },
  ],
};

export const DEFAULT_CASH_RATE_ANNUAL = "0.05";

const REGIME_STRATEGY_PARAM = {
  fundingRatePerSecond: "market.fundingRatePerSecond",
  neutralityBandBps: "market.neutralityBandBps",
  targetLeverage: "market.targetLeverage",
} as const;

/**
 * Starting params for a strategy under one regime. The delta-neutral knobs
 * come from the regime scenario's own `market.*` values so the preset matches
 * what the engine's regime backtests run.
 */
export function defaultParams(
  strategyId: string,
  regime: MarketRegime,
  asset: string
): Record<string, string> {
  if (strategyId === BUY_AND_HOLD_ID) return { asset };
  if (strategyId === DELTA_NEUTRAL_ID) {
    const params = buildRegimeScenario(regime).strategy.params;
    return {
      asset,
      targetLeverage: params[REGIME_STRATEGY_PARAM.targetLeverage] ?? "",
      rebalanceBandBps: params[REGIME_STRATEGY_PARAM.neutralityBandBps] ?? "",
      fundingRatePerSecond:
        params[REGIME_STRATEGY_PARAM.fundingRatePerSecond] ?? "",
    };
  }
  return {};
}

export function hasParamFields(strategyId: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    STRATEGY_PARAM_FIELDS,
    strategyId
  );
}

/** Version the registry lists first for a strategy id, if it is registered. */
export function registeredVersion(strategyId: string): string | undefined {
  return STRATEGY_DEFINITIONS.find((d) => d.id === strategyId)?.version;
}

/** Strategy ids in registration order, without duplicate versions. */
export function registeredStrategyIds(): string[] {
  return Array.from(new Set(STRATEGY_DEFINITIONS.map((d) => d.id)));
}

/**
 * Form values for a regime preset: the window, asset, capital and seed of the
 * engine's regime scenario, with the strategy taken from the registry.
 */
export function presetValues(
  regime: MarketRegime,
  strategyId: string = registeredStrategyIds()[0] ?? ""
): ScenarioFormValues {
  const scenario = buildRegimeScenario(regime);
  const asset = scenario.assets[0] ?? "";
  return {
    regime,
    windowStart: scenario.window.start,
    windowEnd: scenario.window.end,
    windowStep: scenario.window.step,
    assets: scenario.assets.join(", "),
    priceSource: scenario.source.price,
    rateSource: scenario.source.rate,
    startingCapital: scenario.startingCapital,
    seed: scenario.seed,
    strategyId,
    strategyVersion: registeredVersion(strategyId) ?? "",
    params: defaultParams(strategyId, regime, asset),
    paramsText: "",
    cashRateAnnual: DEFAULT_CASH_RATE_ANNUAL,
  };
}

export function defaultFormValues(): ScenarioFormValues {
  const regime = MARKET_REGIMES[0];
  return presetValues(regime);
}

/** Splits `"USDC, EURC"` into symbols, leaving casing to the schema. */
export function parseAssetList(value: string): string[] {
  return value
    .split(",")
    .map((asset) => asset.trim())
    .filter((asset) => asset.length > 0);
}

/**
 * The untrusted scenario object handed to `parseScenario`. Nothing is coerced
 * or defaulted here, so the engine's validator sees exactly what was typed.
 */
export function toScenarioInput(values: ScenarioFormValues): unknown {
  return {
    window: {
      start: values.windowStart.trim(),
      end: values.windowEnd.trim(),
      step: values.windowStep.trim(),
    },
    assets: parseAssetList(values.assets),
    source: { price: values.priceSource, rate: values.rateSource },
    startingCapital: values.startingCapital.trim(),
    strategy: {
      id: values.strategyId.trim(),
      version: values.strategyVersion.trim(),
      params: hasParamFields(values.strategyId)
        ? Object.fromEntries(
            Object.entries(values.params).map(([key, value]) => [
              key,
              value.trim(),
            ])
          )
        : parseParamLines(values.paramsText),
    },
    seed: values.seed,
  };
}

export function toSyntheticMarket(values: ScenarioFormValues): SyntheticMarket {
  return regimeMarket(values.regime, values.cashRateAnnual.trim());
}

/** Parses free-form `key=value` lines for a strategy without param labels. */
export function parseParamLines(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      params[trimmed] = "";
    } else {
      params[trimmed.slice(0, separator).trim()] = trimmed
        .slice(separator + 1)
        .trim();
    }
  }
  return params;
}
