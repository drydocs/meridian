import { describe, it, expect } from "vitest";
import { Decimal } from "../decimal";
import { LiquidationParameterModel } from "./liquidation-parameter";

/** Collateral with an 80% max loan-to-value, an 85% liquidation threshold and a 5% penalty. */
const usdc = new LiquidationParameterModel(
  Decimal.fromString("0.80"),
  Decimal.fromString("0.85"),
  Decimal.fromString("0.05")
);

describe("LiquidationParameterModel", () => {
  describe("constructor", () => {
    it("stores the per-asset parameters", () => {
      expect(usdc.maxLoanToValue.eq(Decimal.fromString("0.80"))).toBe(true);
      expect(usdc.liquidationThreshold.eq(Decimal.fromString("0.85"))).toBe(
        true
      );
      expect(usdc.liquidationPenalty.eq(Decimal.fromString("0.05"))).toBe(true);
    });

    it("rejects a liquidation threshold below the max loan-to-value", () => {
      expect(
        () =>
          new LiquidationParameterModel(
            Decimal.fromString("0.85"),
            Decimal.fromString("0.80"),
            Decimal.fromString("0.05")
          )
      ).toThrow(RangeError);
    });

    it("rejects a negative max loan-to-value", () => {
      expect(
        () =>
          new LiquidationParameterModel(
            Decimal.fromString("-0.01"),
            Decimal.fromString("0.85"),
            Decimal.fromString("0.05")
          )
      ).toThrow(RangeError);
    });

    it("rejects a negative liquidation threshold", () => {
      expect(
        () =>
          new LiquidationParameterModel(
            Decimal.fromString("0.80"),
            Decimal.fromString("-0.85"),
            Decimal.fromString("0.05")
          )
      ).toThrow(RangeError);
    });

    it("rejects a negative liquidation penalty", () => {
      expect(
        () =>
          new LiquidationParameterModel(
            Decimal.fromString("0.80"),
            Decimal.fromString("0.85"),
            Decimal.fromString("-0.05")
          )
      ).toThrow(RangeError);
    });

    it("rejects a zero liquidation threshold", () => {
      expect(
        () =>
          new LiquidationParameterModel(
            Decimal.fromString("0"),
            Decimal.fromString("0"),
            Decimal.fromString("0.05")
          )
      ).toThrow(RangeError);
    });
  });

  describe("computeHealthFactor", () => {
    it("derives the factor from collateral value, threshold and debt", () => {
      // 100 collateral at an 85% threshold discounts to 85, against 50 of debt.
      const healthFactor = usdc.computeHealthFactor(
        Decimal.fromString("100"),
        Decimal.fromString("50")
      );
      expect(healthFactor?.eq(Decimal.fromString("1.7"))).toBe(true);
    });

    it("matches a worked lending example at a different threshold", () => {
      const eth = new LiquidationParameterModel(
        Decimal.fromString("0.75"),
        Decimal.fromString("0.825"),
        Decimal.fromString("0.10")
      );
      // 1.5 ETH at $2000 is $3000 of collateral, discounted to $2475 against $1500 of debt.
      const healthFactor = eth.computeHealthFactor(
        Decimal.fromString("3000"),
        Decimal.fromString("1500")
      );
      expect(healthFactor?.eq(Decimal.fromString("1.65"))).toBe(true);
    });

    it("reports exactly 1.0 at the liquidation boundary", () => {
      const healthFactor = usdc.computeHealthFactor(
        Decimal.fromString("100"),
        Decimal.fromString("85")
      );
      expect(healthFactor?.eq(Decimal.fromString("1"))).toBe(true);
    });

    it("returns undefined when there is no debt", () => {
      expect(
        usdc.computeHealthFactor(
          Decimal.fromString("100"),
          Decimal.fromString("0")
        )
      ).toBeUndefined();
    });

    it("handles operands held at different scales", () => {
      const coarse = new LiquidationParameterModel(
        Decimal.fromString("0.8000", 4),
        Decimal.fromString("0.8500", 4),
        Decimal.fromString("0.0500", 4)
      );
      const healthFactor = coarse.computeHealthFactor(
        Decimal.fromString("100"),
        Decimal.fromString("50")
      );
      expect(healthFactor?.eq(Decimal.fromString("1.7"))).toBe(true);
    });

    it("rejects a negative collateral value", () => {
      expect(() =>
        usdc.computeHealthFactor(
          Decimal.fromString("-100"),
          Decimal.fromString("50")
        )
      ).toThrow(RangeError);
    });

    it("rejects negative debt", () => {
      expect(() =>
        usdc.computeHealthFactor(
          Decimal.fromString("100"),
          Decimal.fromString("-50")
        )
      ).toThrow(RangeError);
    });
  });

  describe("computeLiquidationPrice", () => {
    it("returns the price at which the health factor reaches 1.0", () => {
      // 85 of debt against 100 units of collateral at an 85% threshold.
      const price = usdc.computeLiquidationPrice(
        Decimal.fromString("100"),
        Decimal.fromString("85")
      );
      expect(price?.eq(Decimal.fromString("1"))).toBe(true);
    });

    it("derives a price below 1.0 for a less leveraged position", () => {
      // 50 / (100 * 0.85) = 0.588235294..., rounded half-up at scale 7.
      const price = usdc.computeLiquidationPrice(
        Decimal.fromString("100"),
        Decimal.fromString("50")
      );
      expect(price?.eq(Decimal.fromString("0.5882353"))).toBe(true);
    });

    it("matches a worked lending example at a different threshold", () => {
      const eth = new LiquidationParameterModel(
        Decimal.fromString("0.75"),
        Decimal.fromString("0.825"),
        Decimal.fromString("0.10")
      );
      // 1500 / (1.5 * 0.825) = 1500 / 1.2375 = 1212.1212121...
      const price = eth.computeLiquidationPrice(
        Decimal.fromString("1.5"),
        Decimal.fromString("1500")
      );
      expect(price?.eq(Decimal.fromString("1212.1212121"))).toBe(true);
    });

    it("returns undefined when there is no collateral", () => {
      expect(
        usdc.computeLiquidationPrice(
          Decimal.fromString("0"),
          Decimal.fromString("85")
        )
      ).toBeUndefined();
    });

    it("returns undefined when there is no debt", () => {
      expect(
        usdc.computeLiquidationPrice(
          Decimal.fromString("100"),
          Decimal.fromString("0")
        )
      ).toBeUndefined();
    });

    it("returns undefined when the discounted collateral rounds to zero", () => {
      const dust = new LiquidationParameterModel(
        Decimal.fromString("0.0000001"),
        Decimal.fromString("0.0000001"),
        Decimal.fromString("0")
      );
      expect(
        dust.computeLiquidationPrice(
          Decimal.fromString("0.0000001"),
          Decimal.fromString("1")
        )
      ).toBeUndefined();
    });

    it("rejects a negative collateral amount", () => {
      expect(() =>
        usdc.computeLiquidationPrice(
          Decimal.fromString("-100"),
          Decimal.fromString("85")
        )
      ).toThrow(RangeError);
    });

    it("rejects negative debt", () => {
      expect(() =>
        usdc.computeLiquidationPrice(
          Decimal.fromString("100"),
          Decimal.fromString("-85")
        )
      ).toThrow(RangeError);
    });
  });

  describe("isLiquidatable", () => {
    it("treats a position sitting exactly at the boundary as safe", () => {
      const collateral = Decimal.fromString("100");
      const debt = Decimal.fromString("85");
      expect(usdc.isLiquidatable(collateral, debt)).toBe(false);
    });

    it("treats a position just below the boundary as liquidatable", () => {
      // 85 / 85.00001 is below 1.0 once rounded to scale 7.
      const liquidatable = usdc.isLiquidatable(
        Decimal.fromString("100"),
        Decimal.fromString("85.00001")
      );
      expect(liquidatable).toBe(true);
    });

    it("never liquidates a position carrying no debt", () => {
      expect(
        usdc.isLiquidatable(Decimal.fromString("100"), Decimal.fromString("0"))
      ).toBe(false);
    });

    it("liquidates a position left with debt but no collateral", () => {
      expect(
        usdc.isLiquidatable(Decimal.fromString("0"), Decimal.fromString("100"))
      ).toBe(true);
    });

    it("agrees with the liquidation price it derives", () => {
      const collateral = Decimal.fromString("100");
      const debt = Decimal.fromString("85");
      const price = usdc.computeLiquidationPrice(collateral, debt);
      expect(price?.eq(Decimal.fromString("1"))).toBe(true);

      // Value the collateral at the derived price, then below it. The step is
      // 0.00001 rather than a stroop because the health factor of this position
      // is collateralValue / 100, so a stroop of collateral moves it by 1e-9 and
      // would round away at scale 7.
      const collateralAtPrice = collateral.mul(price ?? Decimal.zero());
      expect(usdc.isLiquidatable(collateralAtPrice, debt)).toBe(false);
      expect(
        usdc.isLiquidatable(
          collateralAtPrice.sub(Decimal.fromString("0.00001")),
          debt
        )
      ).toBe(true);
    });
  });
});
