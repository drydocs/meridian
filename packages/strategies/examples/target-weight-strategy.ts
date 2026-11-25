import {
  FixedPointDecimal,
  KNOWN_ASSETS,
  StrategyParamsError,
} from "../src/index";
import type {
  AssetSymbol,
  Order,
  Strategy,
  StrategyContext,
  StrategyDefinition,
  StrategyInitParams,
} from "../src/index";

const ZERO = FixedPointDecimal.fromStroops(0n);
const ONE = FixedPointDecimal.fromString("1");

export const TARGET_WEIGHT_ID = "target-weight" as const;
export const TARGET_WEIGHT_VERSION = "1.0.0" as const;

export interface TargetWeightConfig {
  readonly asset: AssetSymbol;
  /** Fraction of total portfolio value to hold in `asset`, in `(0, 1]`. */
  readonly targetWeight: FixedPointDecimal;
}

/**
 * Minimal simulation-only example strategy.
 *
 * On each tick, it rebalances the portfolio so the configured asset represents
 * `targetWeight` of total portfolio value, and unwinds the position on `close`.
 */
export class TargetWeightStrategy implements Strategy<TargetWeightConfig> {
  readonly name = TARGET_WEIGHT_ID;
  #config: TargetWeightConfig | null = null;

  init(params: StrategyInitParams<TargetWeightConfig>): void {
    this.#config = params.config;
  }

  step(_context: StrategyContext): void {
    // Stateless example: all decisions are computed from current portfolio and
    // market prices during rebalance.
  }

  rebalance(context: StrategyContext): readonly Order[] {
    const config = this.#requireConfig();
    const price = context.market.prices.get(config.asset);
    if (!price || price.toStroops() <= 0n) {
      return [];
    }

    const totalValue = context.portfolio.totalValue(context.market.prices);
    if (totalValue.toStroops() <= 0n) {
      return [];
    }

    const targetValue = totalValue.mul(config.targetWeight);
    const targetSize = targetValue.div(price);
    const currentSize =
      context.portfolio.getPosition(config.asset)?.size ?? ZERO;
    const delta = targetSize.sub(currentSize);

    if (delta.toStroops() === 0n) {
      return [];
    }

    return [
      {
        asset: config.asset,
        size: delta,
        reason: "rebalance-target-weight",
      },
    ];
  }

  close(context: StrategyContext): readonly Order[] {
    const config = this.#requireConfig();
    const position = context.portfolio.getPosition(config.asset);
    if (!position || position.size.toStroops() === 0n) {
      return [];
    }

    return [
      {
        asset: config.asset,
        size: FixedPointDecimal.fromStroops(-position.size.toStroops()),
        reason: "close",
      },
    ];
  }

  #requireConfig(): TargetWeightConfig {
    if (!this.#config) {
      throw new Error("TargetWeightStrategy has not been initialized");
    }
    return this.#config;
  }
}

function isAssetSymbol(value: string): value is AssetSymbol {
  return KNOWN_ASSETS.has(value);
}

/**
 * StrategyDefinition matching the `@meridian/strategies` registry contract so
 * the example CLI can resolve the strategy from a validated scenario.
 */
export const targetWeightDefinition: StrategyDefinition<TargetWeightConfig> = {
  id: TARGET_WEIGHT_ID,
  version: TARGET_WEIGHT_VERSION,
  create: () => new TargetWeightStrategy(),
  parseParams: (params) => {
    for (const key of Object.keys(params)) {
      if (
        key !== "asset" &&
        key !== "targetWeight" &&
        !key.startsWith("market.")
      ) {
        throw new StrategyParamsError(
          TARGET_WEIGHT_ID,
          key,
          "unknown parameter"
        );
      }
    }

    const rawAsset = params.asset;
    if (!rawAsset || !isAssetSymbol(rawAsset)) {
      throw new StrategyParamsError(
        TARGET_WEIGHT_ID,
        "asset",
        `must be a known asset symbol (got "${String(rawAsset)}")`
      );
    }

    const rawWeight = params.targetWeight;
    if (!rawWeight || !/^\d+(\.\d{1,7})?$/.test(rawWeight)) {
      throw new StrategyParamsError(
        TARGET_WEIGHT_ID,
        "targetWeight",
        `must be a fixed-point decimal string in (0, 1] (got "${String(rawWeight)}")`
      );
    }

    const targetWeight = FixedPointDecimal.fromString(rawWeight);
    if (targetWeight.compareTo(ZERO) <= 0 || targetWeight.compareTo(ONE) > 0) {
      throw new StrategyParamsError(
        TARGET_WEIGHT_ID,
        "targetWeight",
        `must be greater than 0 and at most 1 (got "${rawWeight}")`
      );
    }

    return { asset: rawAsset, targetWeight };
  },
  resolve(params, dependencies) {
    return {
      strategy: this.create(),
      config: this.parseParams(params, dependencies),
    };
  },
};
