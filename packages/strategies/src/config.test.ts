import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";
import {
  ConfigValidationError,
  KNOWN_ASSETS,
  KNOWN_YIELD_SOURCES,
  type RawSelfRepayingLoanConfig,
  parseSelfRepayingLoanConfig,
} from "./config";

describe("parseSelfRepayingLoanConfig", () => {
  const validFixedConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "USDC",
    borrowAsset: "USDG",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.fromString("0.50"), // 50%
    deleverageBuffer: Decimal.fromString("0.10"), // trigger LTV = 0.85 - 0.10 = 0.75
    deleverageTargetLtv: Decimal.fromString("0.60"), // between opening 0.50 and trigger 0.75
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

  describe("accepted configurations", () => {
    it("parses a valid fixed-rate configuration", () => {
      const config = parseSelfRepayingLoanConfig(validFixedConfig);
      expect(config.collateralAsset).toBe("USDC");
      expect(config.borrowAsset).toBe("USDG");
      expect(config.yieldSource).toBe("blend-pool");
      expect(config.borrowRate.mode).toBe("fixed");
      if (config.borrowRate.mode === "fixed") {
        expect(config.borrowRate.fixedRate.toString()).toBe("0.0500000");
      }
    });

    it("parses a valid variable-rate configuration", () => {
      const config = parseSelfRepayingLoanConfig(validVariableConfig);
      expect(config.collateralAsset).toBe("XLM");
      expect(config.borrowAsset).toBe("USDC");
      expect(config.borrowRate.mode).toBe("variable");
      if (config.borrowRate.mode === "variable") {
        expect(config.borrowRate.baseRate.toString()).toBe("0.0200000");
        expect(config.borrowRate.slope1.toString()).toBe("0.0400000");
        expect(config.borrowRate.slope2.toString()).toBe("0.3000000");
        expect(config.borrowRate.optimalUtilization.toString()).toBe(
          "0.8000000"
        );
      }
    });

    it("accepts every known asset and yield source", () => {
      expect(KNOWN_ASSETS.size).toBeGreaterThan(0);
      expect(KNOWN_YIELD_SOURCES.size).toBeGreaterThan(0);
      for (const collateral of KNOWN_ASSETS) {
        for (const borrow of KNOWN_ASSETS) {
          if (collateral === borrow) continue;
          for (const source of KNOWN_YIELD_SOURCES) {
            expect(() =>
              parseSelfRepayingLoanConfig({
                ...validFixedConfig,
                collateralAsset: collateral,
                borrowAsset: borrow,
                yieldSource: source,
              })
            ).not.toThrowError();
          }
        }
      }
    });

    it("accepts a target LTV exactly equal to the opening LTV (boundary)", () => {
      const config = parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        deleverageTargetLtv: Decimal.fromString("0.50"),
      });
      expect(config.deleverageTargetLtv.toString()).toBe("0.5000000");
    });

    it("accepts a target LTV just below the trigger LTV (boundary)", () => {
      // trigger = 0.85 - 0.10 = 0.75; 0.7499999 is strictly below
      const config = parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        deleverageTargetLtv: Decimal.fromString("0.7499999"),
      });
      expect(config.deleverageTargetLtv.toString()).toBe("0.7499999");
    });

    it("accepts a zero liquidation penalty and zero fixed rate", () => {
      const config = parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        liquidationPenalty: Decimal.zero(),
        borrowRate: { mode: "fixed", fixedRate: Decimal.zero() },
      });
      expect(config.liquidationPenalty.isZero()).toBe(true);
    });

    it("accepts a liquidation threshold of exactly one (boundary)", () => {
      const config = parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        liquidationThreshold: Decimal.one(),
        deleverageBuffer: Decimal.fromString("0.10"),
        deleverageTargetLtv: Decimal.fromString("0.60"),
      });
      expect(config.liquidationThreshold.toString()).toBe("1.0000000");
    });

    it("accepts a valid collateral set with zero amounts", () => {
      const config = parseSelfRepayingLoanConfig({
        ...validFixedConfig,
        collateralSet: [
          {
            asset: "XLM",
            amount: Decimal.fromString("100"),
            liquidationModel: new LiquidationParameterModel({
              maxLoanToValue: Decimal.fromString("0.75"),
              liquidationThreshold: Decimal.fromString("0.85"),
              liquidationPenalty: Decimal.fromString("0.05"),
            }),
          },
          {
            asset: "BTC",
            amount: Decimal.zero(),
            liquidationModel: new LiquidationParameterModel({
              maxLoanToValue: Decimal.fromString("0.70"),
              liquidationThreshold: Decimal.fromString("0.80"),
              liquidationPenalty: Decimal.fromString("0.10"),
            }),
          },
        ],
      });
      expect(config.collateralSet).toHaveLength(2);
    });
  });

  describe("rejected invariants", () => {
    it("rejects an unknown collateral asset", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          collateralAsset: "UNKNOWN_TOKEN",
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a missing collateral asset", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          collateralAsset: "",
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects an unknown borrow asset", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowAsset: "RANDOM_COIN",
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects identical collateral and borrow assets", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowAsset: "USDC",
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects an unknown or missing yield source", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          yieldSource: "unverified-ponzi",
        })
      ).toThrowError(ConfigValidationError);
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          yieldSource: "",
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a non-positive opening LTV", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          openingLoanToValue: Decimal.fromString("-0.10"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects an opening LTV of one or more", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          openingLoanToValue: Decimal.one(),
        })
      ).toThrowError(ConfigValidationError);
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          openingLoanToValue: Decimal.fromString("1.01"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a negative or above-one liquidation threshold", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          liquidationThreshold: Decimal.fromString("-0.01"),
        })
      ).toThrowError(ConfigValidationError);
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          liquidationThreshold: Decimal.fromString("1.01"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects an opening LTV at or above the liquidation threshold", () => {
      // Exactly equal (0.85 == 0.85) is rejected
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          openingLoanToValue: Decimal.fromString("0.85"),
          liquidationThreshold: Decimal.fromString("0.85"),
        })
      ).toThrowError(ConfigValidationError);

      // Above is rejected too
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          openingLoanToValue: Decimal.fromString("0.90"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a negative deleverage buffer", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          deleverageBuffer: Decimal.fromString("-0.01"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a deleverage buffer at or above the liquidation threshold", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          deleverageBuffer: Decimal.fromString("0.85"),
        })
      ).toThrowError(ConfigValidationError);
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          deleverageBuffer: Decimal.fromString("0.90"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a target LTV at or above the trigger LTV", () => {
      // trigger LTV = 0.85 - 0.10 = 0.75; target 0.76 must be rejected
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          deleverageTargetLtv: Decimal.fromString("0.76"),
        })
      ).toThrowError(ConfigValidationError);

      // Exactly at the trigger is rejected too
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          deleverageTargetLtv: Decimal.fromString("0.75"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a target LTV below the opening LTV", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          deleverageTargetLtv: Decimal.fromString("0.45"), // < opening 0.50
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a negative liquidation penalty", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          liquidationPenalty: Decimal.fromString("-0.05"),
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects a missing or invalid borrow rate mode", () => {
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
            mode: "floater",
          } as unknown as RawSelfRepayingLoanConfig["borrowRate"],
        })
      ).toThrowError(ConfigValidationError);
    });
  });

  describe("fixed-rate mode validation", () => {
    it("rejects a negative fixed rate", () => {
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
  });

  describe("variable-rate mode validation", () => {
    it("rejects a negative base rate", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("-0.02"),
            slope1: Decimal.fromString("0.04"),
            slope2: Decimal.fromString("0.30"),
            optimalUtilization: Decimal.fromString("0.80"),
          },
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects negative slopes", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("0.02"),
            slope1: Decimal.fromString("-0.04"),
            slope2: Decimal.fromString("0.30"),
            optimalUtilization: Decimal.fromString("0.80"),
          },
        })
      ).toThrowError(ConfigValidationError);

      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("0.02"),
            slope1: Decimal.fromString("0.04"),
            slope2: Decimal.fromString("-0.30"),
            optimalUtilization: Decimal.fromString("0.80"),
          },
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects an optimal utilization below zero or above one", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("0.02"),
            slope1: Decimal.fromString("0.04"),
            slope2: Decimal.fromString("0.30"),
            optimalUtilization: Decimal.fromString("-0.10"),
          },
        })
      ).toThrowError(ConfigValidationError);

      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("0.02"),
            slope1: Decimal.fromString("0.04"),
            slope2: Decimal.fromString("0.30"),
            optimalUtilization: Decimal.fromString("1.10"),
          },
        })
      ).toThrowError(ConfigValidationError);
    });

    it("accepts an optimal utilization of exactly zero and one", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("0.02"),
            slope1: Decimal.fromString("0.04"),
            slope2: Decimal.fromString("0.30"),
            optimalUtilization: Decimal.zero(),
          },
        })
      ).not.toThrowError();

      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          borrowRate: {
            mode: "variable",
            baseRate: Decimal.fromString("0.02"),
            slope1: Decimal.fromString("0.04"),
            slope2: Decimal.fromString("0.30"),
            optimalUtilization: Decimal.one(),
          },
        })
      ).not.toThrowError();
    });
  });

  describe("collateral set validation", () => {
    it("rejects an empty collateral set", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          collateralSet: [],
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects unknown assets inside the collateral set", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          collateralSet: [
            {
              asset: "MOON_COIN",
              amount: Decimal.fromString("1"),
              liquidationModel: new LiquidationParameterModel({
                maxLoanToValue: Decimal.fromString("0.75"),
                liquidationThreshold: Decimal.fromString("0.85"),
                liquidationPenalty: Decimal.fromString("0.05"),
              }),
            },
          ],
        })
      ).toThrowError(ConfigValidationError);
    });

    it("rejects negative amounts inside the collateral set", () => {
      expect(() =>
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          collateralSet: [
            {
              asset: "XLM",
              amount: Decimal.fromString("-100"),
              liquidationModel: new LiquidationParameterModel({
                maxLoanToValue: Decimal.fromString("0.75"),
                liquidationThreshold: Decimal.fromString("0.85"),
                liquidationPenalty: Decimal.fromString("0.05"),
              }),
            },
          ],
        })
      ).toThrowError(ConfigValidationError);
    });
  });

  describe("error metadata", () => {
    it("tags errors with the offending field name", () => {
      try {
        parseSelfRepayingLoanConfig({
          ...validFixedConfig,
          yieldSource: "nope",
        });
        expect.unreachable("expected parseSelfRepayingLoanConfig to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).field).toBe("yieldSource");
        expect((error as ConfigValidationError).name).toBe(
          "ConfigValidationError"
        );
        expect((error as ConfigValidationError).message).toContain(
          "yieldSource"
        );
      }
    });
  });
});
