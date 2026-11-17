import {
  FixedPointDecimal,
  KNOWN_ASSETS,
  STROOPS_PER_UNIT,
  StrategyParamsError,
  defineStrategy,
} from "../src/index";
import type {
  AssetSymbol,
  Order,
  Strategy,
  StrategyContext,
  StrategyInitParams,
} from "../src/index";

export const THRESHOLD_REBALANCE_ID = "threshold-rebalance";
export const THRESHOLD_REBALANCE_VERSION = "1.0.0";

export interface ThresholdRebalanceConfig {
  readonly asset: AssetSymbol;
  readonly targetWeight: FixedPointDecimal;
  readonly driftBps: number;
}

const BPS_DENOMINATOR = 10_000n;
const ENTRY_HEADROOM_BPS = 25n;

/**
 * Minimal simulation-only example strategy implementing `Strategy<TConfig>`.
 *
 * Maintains a fixed target portfolio weight in `config.asset`, trading back to
 * target whenever the marked weight drifts beyond `config.driftBps`, and
 * unwinding the position cleanly on `close`.
 */
export class ThresholdRebalanceStrategy implements Strategy<ThresholdRebalanceConfig> {
  readonly name = THRESHOLD_REBALANCE_ID;
  #config!: ThresholdRebalanceConfig;
  #deltaUnits = 0n;

  init(params: StrategyInitParams<ThresholdRebalanceConfig>): void {
    this.#config = params.config;
    this.#deltaUnits = 0n;
  }

  step(context: StrategyContext): void {
    const price = context.market.prices.get(this.#config.asset)!;
    const totalStroops = context.portfolio
      .totalValue(context.market.prices)
      .toStroops();
    const heldSize =
      context.portfolio.getPosition(this.#config.asset)?.size.toStroops() ?? 0n;
    const heldValue = (heldSize * price.toStroops()) / STROOPS_PER_UNIT;
    const targetValue =
      (totalStroops *
        this.#config.targetWeight.toStroops() *
        (BPS_DENOMINATOR - ENTRY_HEADROOM_BPS)) /
      (STROOPS_PER_UNIT * BPS_DENOMINATOR);

    const diff =
      heldValue >= targetValue
        ? heldValue - targetValue
        : targetValue - heldValue;
    const band =
      (totalStroops * BigInt(this.#config.driftBps)) / BPS_DENOMINATOR;

    this.#deltaUnits =
      diff > band
        ? ((targetValue - heldValue) * STROOPS_PER_UNIT) / price.toStroops()
        : 0n;
  }

  rebalance(_context: StrategyContext): readonly Order[] {
    void _context;
    if (this.#deltaUnits === 0n) return [];
    return [
      {
        asset: this.#config.asset,
        size: FixedPointDecimal.fromStroops(this.#deltaUnits),
        reason: "rebalance to target weight",
      },
    ];
  }

  close(context: StrategyContext): readonly Order[] {
    const position = context.portfolio.getPosition(this.#config.asset);
    if (!position) return [];
    return [
      {
        asset: this.#config.asset,
        size: FixedPointDecimal.fromStroops(-position.size.toStroops()),
        reason: "unwind at close",
      },
    ];
  }
}

const ALLOWED_STRATEGY_PARAMS = ["asset", "targetWeight", "driftBps"] as const;
const DECIMAL_PATTERN = /^\d+(?:\.\d{1,7})?$/;

export const thresholdRebalanceDefinition =
  defineStrategy<ThresholdRebalanceConfig>({
    id: THRESHOLD_REBALANCE_ID,
    version: THRESHOLD_REBALANCE_VERSION,
    create: () => new ThresholdRebalanceStrategy(),
    parseParams(params) {
      for (const key of Object.keys(params)) {
        if (key.startsWith("market.")) continue;
        if (!(ALLOWED_STRATEGY_PARAMS as readonly string[]).includes(key)) {
          throw new StrategyParamsError(
            THRESHOLD_REBALANCE_ID,
            key,
            `unknown param. Allowed: ${ALLOWED_STRATEGY_PARAMS.join(", ")}`
          );
        }
      }

      const asset = params.asset;
      if (!asset || !KNOWN_ASSETS.has(asset)) {
        throw new StrategyParamsError(
          THRESHOLD_REBALANCE_ID,
          "asset",
          `'${String(asset ?? "")}' is not a known asset`
        );
      }

      const rawWeight = params.targetWeight;
      if (!rawWeight || !DECIMAL_PATTERN.test(rawWeight)) {
        throw new StrategyParamsError(
          THRESHOLD_REBALANCE_ID,
          "targetWeight",
          "must be a non-negative decimal string with at most 7 fractional digits"
        );
      }
      const targetWeight = FixedPointDecimal.fromString(rawWeight);
      if (
        targetWeight.toStroops() <= 0n ||
        targetWeight.toStroops() > STROOPS_PER_UNIT
      ) {
        throw new StrategyParamsError(
          THRESHOLD_REBALANCE_ID,
          "targetWeight",
          "must be in (0, 1]"
        );
      }

      const rawDrift = params.driftBps;
      if (!rawDrift || !/^\d+$/.test(rawDrift)) {
        throw new StrategyParamsError(
          THRESHOLD_REBALANCE_ID,
          "driftBps",
          "must be a non-negative integer string"
        );
      }

      return {
        asset: asset as AssetSymbol,
        targetWeight,
        driftBps: Number(rawDrift),
      };
    },
  });
