import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";

describe("LiquidationParameterModel", () => {
  const model = new LiquidationParameterModel({
    maxLoanToValue: Decimal.fromString("0.80"), // 80%
    liquidationThreshold: Decimal.fromString("0.85"), // 85%
    liquidationPenalty: Decimal.fromString("0.05"), // 5%
  });

  describe("constructor", () => {
    it("stores the configured parameters", () => {
      expect(model.maxLoanToValue.toString()).toBe("0.8000000");
      expect(model.liquidationThreshold.toString()).toBe("0.8500000");
      expect(model.liquidationPenalty.toString()).toBe("0.0500000");
    });

    it("rejects a threshold below the max LTV", () => {
      expect(
        () =>
          new LiquidationParameterModel({
            maxLoanToValue: Decimal.fromString("0.90"),
            liquidationThreshold: Decimal.fromString("0.85"),
            liquidationPenalty: Decimal.zero(),
          })
      ).toThrowError(RangeError);
    });

    it("accepts a threshold equal to the max LTV", () => {
      expect(
        () =>
          new LiquidationParameterModel({
            maxLoanToValue: Decimal.fromString("0.85"),
            liquidationThreshold: Decimal.fromString("0.85"),
            liquidationPenalty: Decimal.zero(),
          })
      ).not.toThrowError();
    });

    it("rejects negative parameters", () => {
      expect(
        () =>
          new LiquidationParameterModel({
            maxLoanToValue: Decimal.fromString("-0.10"),
            liquidationThreshold: Decimal.fromString("0.85"),
            liquidationPenalty: Decimal.zero(),
          })
      ).toThrowError(RangeError);

      expect(
        () =>
          new LiquidationParameterModel({
            maxLoanToValue: Decimal.fromString("0.80"),
            liquidationThreshold: Decimal.fromString("-0.85"),
            liquidationPenalty: Decimal.zero(),
          })
      ).toThrowError(RangeError);

      expect(
        () =>
          new LiquidationParameterModel({
            maxLoanToValue: Decimal.fromString("0.80"),
            liquidationThreshold: Decimal.fromString("0.85"),
            liquidationPenalty: Decimal.fromString("-0.05"),
          })
      ).toThrowError(RangeError);
    });
  });

  describe("computeHealthFactor", () => {
    it("computes HF = collateral value * threshold / debt", () => {
      // (1,000 * 0.85) / 500 = 1.70
      expect(
        model
          .computeHealthFactor(
            Decimal.fromString("1000"),
            Decimal.fromString("500")
          )
          ?.toString()
      ).toBe("1.7000000");
    });

    it("returns undefined for zero debt (infinite health)", () => {
      expect(
        model.computeHealthFactor(Decimal.fromString("1000"), Decimal.zero())
      ).toBeUndefined();
    });
  });

  describe("computeLiquidationPrice", () => {
    it("computes the price below which the position is liquidatable", () => {
      // 500 / (1,000 * 0.85) = 0.5882353
      expect(
        model
          .computeLiquidationPrice(
            Decimal.fromString("1000"),
            Decimal.fromString("500")
          )
          .toString()
      ).toBe("0.5882353");
    });

    it("returns zero when there is no collateral", () => {
      expect(
        model
          .computeLiquidationPrice(Decimal.zero(), Decimal.fromString("500"))
          .isZero()
      ).toBe(true);
    });

    it("returns zero when the adjusted collateral rounds to zero", () => {
      // A 0.0000001 threshold times 0.0000001 collateral rounds to zero
      // at stroop scale, hitting the zero-adjusted-collateral guard.
      const tinyThresholdModel = new LiquidationParameterModel({
        maxLoanToValue: Decimal.zero(),
        liquidationThreshold: Decimal.fromString("0.0000001"),
        liquidationPenalty: Decimal.zero(),
      });
      expect(
        tinyThresholdModel
          .computeLiquidationPrice(
            Decimal.fromString("0.0000001"),
            Decimal.fromString("500")
          )
          .isZero()
      ).toBe(true);
    });

    it("returns zero when the threshold is zero", () => {
      const zeroThresholdModel = new LiquidationParameterModel({
        maxLoanToValue: Decimal.zero(),
        liquidationThreshold: Decimal.zero(),
        liquidationPenalty: Decimal.zero(),
      });
      expect(
        zeroThresholdModel
          .computeLiquidationPrice(
            Decimal.fromString("1000"),
            Decimal.fromString("500")
          )
          .isZero()
      ).toBe(true);
    });
  });

  describe("isLiquidatable", () => {
    it("is safe exactly at a health factor of 1.0 (boundary)", () => {
      // (850 * 0.85) / 722.5 = 1.0 exactly -> safe
      expect(
        model.isLiquidatable(
          Decimal.fromString("850"),
          Decimal.fromString("722.5")
        )
      ).toBe(false);
    });

    it("is liquidatable below a health factor of 1.0", () => {
      // (1,000 * 0.85) / 1,000 = 0.85 < 1.0
      expect(
        model.isLiquidatable(
          Decimal.fromString("1000"),
          Decimal.fromString("1000")
        )
      ).toBe(true);
    });

    it("is never liquidatable without debt", () => {
      expect(model.isLiquidatable(Decimal.zero(), Decimal.zero())).toBe(false);
      expect(
        model.isLiquidatable(Decimal.fromString("1000"), Decimal.zero())
      ).toBe(false);
    });
  });
});
