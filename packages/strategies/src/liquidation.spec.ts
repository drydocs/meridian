import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";

describe("LiquidationParameterModel", () => {
  const model = new LiquidationParameterModel({
    maxLoanToValue: Decimal.fromString("0.80"),
    liquidationThreshold: Decimal.fromString("0.85"),
    liquidationPenalty: Decimal.fromString("0.05"),
  });

  it("should validate threshold is greater than or equal to max LTV", () => {
    expect(
      () =>
        new LiquidationParameterModel({
          maxLoanToValue: Decimal.fromString("0.85"),
          liquidationThreshold: Decimal.fromString("0.80"),
          liquidationPenalty: Decimal.fromString("0.05"),
        })
    ).toThrow();
  });

  it("should compute health factor correctly", () => {
    // Collateral = $100, Threshold = 85%, Debt = $50 -> HF = 1.7
    const hf = model.computeHealthFactor(
      Decimal.fromString("100"),
      Decimal.fromString("50")
    );
    expect(hf?.toString()).toBe("1.7000000");
  });

  it("should compute liquidation price correctly", () => {
    // Collateral = 100 units, Threshold = 85%, Debt = $85 -> Liq Price = 85 / (100 * 0.85) = 1.0
    const liqPrice = model.computeLiquidationPrice(
      Decimal.fromString("100"),
      Decimal.fromString("85")
    );
    expect(liqPrice.toString()).toBe("1.0000000");
  });

  it("should treat health factor of exactly 1.0 as safe (not liquidatable)", () => {
    // Collateral = $100, Threshold = 85%, Debt = $85 -> HF = 1.0
    expect(
      model.isLiquidatable(Decimal.fromString("100"), Decimal.fromString("85"))
    ).toBe(false);

    // Debt = $86 -> HF = 85 / 86 < 1.0 -> Liquidatable
    expect(
      model.isLiquidatable(Decimal.fromString("100"), Decimal.fromString("86"))
    ).toBe(true);
  });
});
