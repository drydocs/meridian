import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";
import {
  parseSelfRepayingLoanConfig,
  RawSelfRepayingLoanConfig,
  ConfigValidationError,
} from "./config";

describe("parseSelfRepayingLoanConfig", () => {
  const liquidationModel = new LiquidationParameterModel(
    Decimal.fromString("0.80"),
    Decimal.fromString("0.85"),
    Decimal.fromString("0.05")
  );

  const validFixedConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "USDC",
    borrowAsset: "USDG",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.fromString("0.50"), // 50%
    deleverageBuffer: Decimal.fromString("0.10"), // 10% below threshold -> trigger at 75%
    deleverageTargetLtv: Decimal.fromString("0.60"), // 60% (between opening 50% and trigger 75%)
    liquidationThreshold: Decimal.fromString("0.85"), // 85%
    liquidationPenalty: Decimal.fromString("0.05"), // 5%
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.fromString("0.05"), // 5%
    },
  };

  const validVariableConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "XLM",
    borrowAsset: "USDC",
    yieldSource: "defindex-vault",
    openingLoanToValue: Decimal.fromString("0.40"),
    deleverageBuffer: Decimal.fromString("0.05"),
    deleverageTargetLtv: Decimal.fromString("0.50"),
    liquidationThreshold: Decimal.fromString("0.70"),
    liquidationPenalty: Decimal.fromString("0.10"),
    borrowRate: {
      mode: "variable",
      baseRate: Decimal.fromString("0.02"),
      slope1: Decimal.fromString("0.04"),
      slope2: Decimal.fromString("0.30"),
      optimalUtilization: Decimal.fromString("0.80"),
    },
  };

  it("should parse valid fixed-rate configuration", () => {
    const config = parseSelfRepayingLoanConfig(validFixedConfig);
    expect(config.collateralAsset).toBe("USDC");
    expect(config.borrowAsset).toBe("USDG");
    expect(config.borrowRate.mode).toBe("fixed");
    if (config.borrowRate.mode === "fixed") {
      expect(config.borrowRate.fixedRate.toString()).toBe("0.0500000");
    }
  });

  it("should parse valid variable-rate configuration", () => {
    const config = parseSelfRepayingLoanConfig(validVariableConfig);
    expect(config.collateralAsset).toBe("XLM");
    expect(config.borrowAsset).toBe("USDC");
    expect(config.borrowRate.mode).toBe("variable");
    if (config.borrowRate.mode === "variable") {
      expect(config.borrowRate.optimalUtilization.toString()).toBe("0.8000000");
    }
  });

  it("should reject unknown collateral asset", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        collateralAsset: "UNKNOWN_TOKEN",
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject unknown borrow asset", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        borrowAsset: "RANDOM_COIN",
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject identical collateral and borrow asset", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        collateralAsset: "USDC",
        borrowAsset: "USDC",
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject unknown yield source", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        yieldSource: "unverified-ponzi",
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject opening loan-to-value >= liquidation threshold", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        openingLoanToValue: Decimal.fromString("0.85"),
        liquidationThreshold: Decimal.fromString("0.85"),
      })
    ).toThrowError(ConfigValidationError);

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        openingLoanToValue: Decimal.fromString("0.90"),
        liquidationThreshold: Decimal.fromString("0.85"),
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject inconsistent deleverage buffer and target LTV ordering", () => {
    // liquidationThreshold = 0.85, buffer = 0.10 -> triggerLtv = 0.75
    // If target LTV is 0.76 (>= 0.75 trigger LTV), reject
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        deleverageTargetLtv: Decimal.fromString("0.76"),
      })
    ).toThrowError(ConfigValidationError);

    // If target LTV is below opening LTV (0.45 < 0.50), reject
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        deleverageTargetLtv: Decimal.fromString("0.45"),
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject negative borrow rates", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        borrowRate: {
          mode: "fixed",
          fixedRate: Decimal.fromString("-0.01"),
        },
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject an opening loan-to-value outside the 0 to 1 range", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        openingLoanToValue: Decimal.fromString("1"),
      })
    ).toThrowError(/Opening loan-to-value must be between 0 and 1/);

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        openingLoanToValue: Decimal.fromString("-0.10"),
      })
    ).toThrowError(/Opening loan-to-value must be between 0 and 1/);
  });

  it("should reject a liquidation threshold outside the 0 to 1 range", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        liquidationThreshold: Decimal.fromString("1.20"),
      })
    ).toThrowError(ConfigValidationError);

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        liquidationThreshold: Decimal.fromString("-0.10"),
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject a deleverage buffer outside the 0 to threshold range", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        deleverageBuffer: Decimal.fromString("-0.05"),
      })
    ).toThrowError(
      /Deleverage buffer must be positive and strictly below liquidation threshold/
    );

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        deleverageBuffer: Decimal.fromString("0.85"),
      })
    ).toThrowError(
      /Deleverage buffer must be positive and strictly below liquidation threshold/
    );
  });

  it("should reject a negative liquidation penalty", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        liquidationPenalty: Decimal.fromString("-0.01"),
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject a missing or unknown borrow rate mode", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        borrowRate:
          undefined as unknown as RawSelfRepayingLoanConfig["borrowRate"],
      })
    ).toThrowError(ConfigValidationError);

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        borrowRate: {
          mode: "floating",
          fixedRate: Decimal.fromString("0.05"),
        } as unknown as RawSelfRepayingLoanConfig["borrowRate"],
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject negative or out-of-range variable borrow rates", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validVariableConfig,
        borrowRate: {
          mode: "variable",
          baseRate: Decimal.fromString("-0.01"),
          slope1: Decimal.fromString("0.04"),
          slope2: Decimal.fromString("0.30"),
          optimalUtilization: Decimal.fromString("0.80"),
        },
      })
    ).toThrowError(ConfigValidationError);

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validVariableConfig,
        borrowRate: {
          mode: "variable",
          baseRate: Decimal.fromString("0.02"),
          slope1: Decimal.fromString("0.04"),
          slope2: Decimal.fromString("-0.01"),
          optimalUtilization: Decimal.fromString("0.80"),
        },
      })
    ).toThrowError(ConfigValidationError);

    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validVariableConfig,
        borrowRate: {
          mode: "variable",
          baseRate: Decimal.fromString("0.02"),
          slope1: Decimal.fromString("0.04"),
          slope2: Decimal.fromString("0.30"),
          optimalUtilization: Decimal.fromString("1.20"),
        },
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject an empty collateral set", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        collateralSet: [],
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject an unknown asset in the collateral set", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        collateralSet: [
          {
            asset: "DOGE",
            amount: Decimal.fromString("100"),
            liquidationModel,
          },
        ],
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should reject a negative amount in the collateral set", () => {
    expect(() =>
      parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        collateralSet: [
          {
            asset: "ETH",
            amount: Decimal.fromString("-1"),
            liquidationModel,
          },
        ],
      })
    ).toThrowError(ConfigValidationError);
  });

  it("should parse a valid collateral set", () => {
    const config = parseSelfRepayingLoanConfig({
      ...validFixedConfig,
      collateralSet: [
        { asset: "USDC", amount: Decimal.fromString("1000"), liquidationModel },
        { asset: "ETH", amount: Decimal.fromString("0.5"), liquidationModel },
      ],
    });

    expect(config.collateralSet).toHaveLength(2);
    expect(config.collateralSet?.[1]?.asset).toBe("ETH");
  });
});
