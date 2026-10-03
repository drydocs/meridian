import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";

export type RateMode = "fixed" | "variable";

export interface FixedRateConfig {
  readonly mode: "fixed";
  readonly fixedRate: Decimal; // Annual or period fixed borrow rate (e.g. 0.05 = 5%)
}

export interface VariableRateConfig {
  readonly mode: "variable";
  readonly baseRate: Decimal; // Minimum base rate
  readonly slope1: Decimal; // Rate slope below optimal utilization
  readonly slope2: Decimal; // Rate slope above optimal utilization
  readonly optimalUtilization: Decimal; // Optimal utilization target (e.g. 0.80)
}

export type BorrowRateConfig = FixedRateConfig | VariableRateConfig;

export interface CollateralConfig {
  readonly asset: string;
  readonly amount: Decimal;
  readonly liquidationModel: LiquidationParameterModel;
}

export interface RawSelfRepayingLoanConfig {
  readonly collateralAsset: string;
  readonly borrowAsset: string;
  readonly yieldSource: string;
  readonly openingLoanToValue: Decimal;
  readonly deleverageBuffer: Decimal; // Buffer above threshold where deleveraging begins (e.g. 0.05 = 5%)
  readonly deleverageTargetLtv: Decimal; // Target LTV to restore to after deleveraging
  readonly liquidationThreshold: Decimal;
  readonly liquidationPenalty: Decimal;
  readonly borrowRate: BorrowRateConfig;
  readonly initialCollateralAmount?: Decimal;
  readonly collateralSet?: CollateralConfig[];
}

export interface SelfRepayingLoanConfig {
  readonly collateralAsset: string;
  readonly borrowAsset: string;
  readonly yieldSource: string;
  readonly openingLoanToValue: Decimal;
  readonly deleverageBuffer: Decimal;
  readonly deleverageTargetLtv: Decimal;
  readonly liquidationThreshold: Decimal;
  readonly liquidationPenalty: Decimal;
  readonly borrowRate: BorrowRateConfig;
  readonly initialCollateralAmount?: Decimal;
  readonly collateralSet?: CollateralConfig[];
}

export const KNOWN_ASSETS = new Set([
  "USDC",
  "XLM",
  "USDG",
  "EURC",
  "BTC",
  "ETH",
]);
export const KNOWN_YIELD_SOURCES = new Set([
  "blend-pool",
  "defindex-vault",
  "stellar-anchor",
  "meridian-vault",
]);

export class ConfigValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Invalid config field '${field}': ${message}`);
    this.name = "ConfigValidationError";
    this.field = field;
  }
}

export function parseSelfRepayingLoanConfig(
  raw: RawSelfRepayingLoanConfig
): SelfRepayingLoanConfig {
  if (!raw.collateralAsset || !KNOWN_ASSETS.has(raw.collateralAsset)) {
    throw new ConfigValidationError(
      "collateralAsset",
      `Unknown or missing collateral asset '${raw.collateralAsset}'. Allowed: ${Array.from(KNOWN_ASSETS).join(", ")}`
    );
  }

  if (!raw.borrowAsset || !KNOWN_ASSETS.has(raw.borrowAsset)) {
    throw new ConfigValidationError(
      "borrowAsset",
      `Unknown or missing borrow asset '${raw.borrowAsset}'. Allowed: ${Array.from(KNOWN_ASSETS).join(", ")}`
    );
  }

  if (raw.collateralAsset === raw.borrowAsset) {
    throw new ConfigValidationError(
      "borrowAsset",
      `Borrow asset cannot be identical to collateral asset '${raw.collateralAsset}'`
    );
  }

  if (!raw.yieldSource || !KNOWN_YIELD_SOURCES.has(raw.yieldSource)) {
    throw new ConfigValidationError(
      "yieldSource",
      `Unknown or missing yield source '${raw.yieldSource}'. Allowed: ${Array.from(KNOWN_YIELD_SOURCES).join(", ")}`
    );
  }

  // Value validations
  if (
    raw.openingLoanToValue.isNegative() ||
    raw.openingLoanToValue.gte(Decimal.one())
  ) {
    throw new ConfigValidationError(
      "openingLoanToValue",
      `Opening loan-to-value must be between 0 and 1 (exclusive), got ${raw.openingLoanToValue.toString()}`
    );
  }

  if (
    raw.liquidationThreshold.isNegative() ||
    raw.liquidationThreshold.gt(Decimal.one())
  ) {
    throw new ConfigValidationError(
      "liquidationThreshold",
      `Liquidation threshold must be between 0 and 1, got ${raw.liquidationThreshold.toString()}`
    );
  }

  // Invariant: opening LTV must sit strictly below liquidation threshold
  if (raw.openingLoanToValue.gte(raw.liquidationThreshold)) {
    throw new ConfigValidationError(
      "openingLoanToValue",
      `Opening loan-to-value (${raw.openingLoanToValue.toString()}) must be strictly below liquidation threshold (${raw.liquidationThreshold.toString()})`
    );
  }

  // Buffer and target LTV ordering:
  // Deleverage buffer is the safety margin below liquidation threshold where deleveraging begins.
  // deleverageTriggerLtv = liquidationThreshold - deleverageBuffer
  // Opening LTV <= deleverageTargetLtv < (liquidationThreshold - deleverageBuffer)
  if (
    raw.deleverageBuffer.isNegative() ||
    raw.deleverageBuffer.gte(raw.liquidationThreshold)
  ) {
    throw new ConfigValidationError(
      "deleverageBuffer",
      `Deleverage buffer must be positive and strictly below liquidation threshold, got ${raw.deleverageBuffer.toString()}`
    );
  }

  const triggerLtv = raw.liquidationThreshold.sub(raw.deleverageBuffer);
  if (raw.deleverageTargetLtv.gte(triggerLtv)) {
    throw new ConfigValidationError(
      "deleverageTargetLtv",
      `Deleverage target LTV (${raw.deleverageTargetLtv.toString()}) must be strictly below deleverage trigger LTV (${triggerLtv.toString()})`
    );
  }

  if (raw.deleverageTargetLtv.lt(raw.openingLoanToValue)) {
    throw new ConfigValidationError(
      "deleverageTargetLtv",
      `Deleverage target LTV (${raw.deleverageTargetLtv.toString()}) cannot be less than opening LTV (${raw.openingLoanToValue.toString()})`
    );
  }

  if (raw.liquidationPenalty.isNegative()) {
    throw new ConfigValidationError(
      "liquidationPenalty",
      `Liquidation penalty cannot be negative, got ${raw.liquidationPenalty.toString()}`
    );
  }

  // Rate mode validation
  if (
    !raw.borrowRate ||
    (raw.borrowRate.mode !== "fixed" && raw.borrowRate.mode !== "variable")
  ) {
    throw new ConfigValidationError(
      "borrowRate",
      "Borrow rate config must specify mode as 'fixed' or 'variable'"
    );
  }

  if (raw.borrowRate.mode === "fixed") {
    if (raw.borrowRate.fixedRate.isNegative()) {
      throw new ConfigValidationError(
        "borrowRate.fixedRate",
        `Fixed borrow rate cannot be negative, got ${raw.borrowRate.fixedRate.toString()}`
      );
    }
  } else {
    if (raw.borrowRate.baseRate.isNegative()) {
      throw new ConfigValidationError(
        "borrowRate.baseRate",
        `Base borrow rate cannot be negative, got ${raw.borrowRate.baseRate.toString()}`
      );
    }
    if (
      raw.borrowRate.slope1.isNegative() ||
      raw.borrowRate.slope2.isNegative()
    ) {
      throw new ConfigValidationError(
        "borrowRate.slope",
        "Borrow rate slopes cannot be negative"
      );
    }
    if (
      raw.borrowRate.optimalUtilization.isNegative() ||
      raw.borrowRate.optimalUtilization.gt(Decimal.one())
    ) {
      throw new ConfigValidationError(
        "borrowRate.optimalUtilization",
        `Optimal utilization must be between 0 and 1, got ${raw.borrowRate.optimalUtilization.toString()}`
      );
    }
  }

  // Optional collateral set validation
  if (raw.collateralSet) {
    if (raw.collateralSet.length === 0) {
      throw new ConfigValidationError(
        "collateralSet",
        "Collateral set cannot be empty if provided"
      );
    }
    for (const coll of raw.collateralSet) {
      if (!KNOWN_ASSETS.has(coll.asset)) {
        throw new ConfigValidationError(
          "collateralSet.asset",
          `Unknown asset '${coll.asset}' in collateral set`
        );
      }
      if (coll.amount.isNegative()) {
        throw new ConfigValidationError(
          "collateralSet.amount",
          `Collateral amount cannot be negative for asset '${coll.asset}'`
        );
      }
    }
  }

  return {
    ...raw,
  };
}
