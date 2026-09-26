import { describe, it, expect } from "vitest";
import { LiquidationParameterModel, FIXED_POINT_SCALE } from "./liquidation-parameter";

describe("LiquidationParameterModel", () => {
  const maxLtv = (8000n * FIXED_POINT_SCALE) / 10000n; // 80%
  const threshold = (8500n * FIXED_POINT_SCALE) / 10000n; // 85%
  const penalty = (500n * FIXED_POINT_SCALE) / 10000n; // 5%

  it("should initialize correctly", () => {
    const model = new LiquidationParameterModel(maxLtv, threshold, penalty);
    expect(model.maxLoanToValue).toBe(maxLtv);
    expect(model.liquidationThreshold).toBe(threshold);
    expect(model.liquidationPenalty).toBe(penalty);
  });

  it("should reject a threshold below max loan-to-value", () => {
    expect(() => new LiquidationParameterModel(threshold, maxLtv, penalty)).toThrow();
  });

  describe("health factor", () => {
    const model = new LiquidationParameterModel(maxLtv, threshold, penalty);

    it("computes health factor correctly", () => {
      // Collateral = 100, Debt = 50, Threshold = 85%
      // HF = (100 * 0.85) / 50 = 1.7
      const collateral = 100n * FIXED_POINT_SCALE;
      const debt = 50n * FIXED_POINT_SCALE;
      const hf = model.computeHealthFactor(collateral, debt);
      expect(hf).toBe((17000n * FIXED_POINT_SCALE) / 10000n);
    });

    it("returns -1 for zero debt (infinite health factor)", () => {
      const hf = model.computeHealthFactor(100n * FIXED_POINT_SCALE, 0n);
      expect(hf).toBe(-1n);
    });
  });

  describe("liquidation price", () => {
    const model = new LiquidationParameterModel(maxLtv, threshold, penalty);

    it("computes liquidation price correctly", () => {
      // Debt = 85, Collateral = 100, Threshold = 85%
      // Liquidation Price = 85 / (100 * 0.85) = 1.0
      const collateral = 100n * FIXED_POINT_SCALE;
      const debt = 85n * FIXED_POINT_SCALE;
      const price = model.computeLiquidationPrice(collateral, debt);
      expect(price).toBe(1n * FIXED_POINT_SCALE);

      // Debt = 50, Collateral = 100, Threshold = 85%
      // Liquidation Price = 50 / (100 * 0.85) = 50 / 85 = 0.588235294117647058
      const debt2 = 50n * FIXED_POINT_SCALE;
      const price2 = model.computeLiquidationPrice(collateral, debt2);
      expect(price2).toBe((50n * FIXED_POINT_SCALE) / 85n);
    });

    it("returns 0 if collateral is 0", () => {
      expect(model.computeLiquidationPrice(0n, 100n)).toBe(0n);
    });
  });

  describe("boundary behavior", () => {
    const model = new LiquidationParameterModel(maxLtv, threshold, penalty);

    it("is not liquidatable when health factor is exactly 1.0", () => {
      // Collateral = 100, Debt = 85, Threshold = 85%
      // HF = 1.0
      const collateral = 100n * FIXED_POINT_SCALE;
      const debt = 85n * FIXED_POINT_SCALE;
      
      const hf = model.computeHealthFactor(collateral, debt);
      expect(hf).toBe(FIXED_POINT_SCALE); // exactly 1.0
      expect(model.isLiquidatable(collateral, debt)).toBe(false);
    });

    it("is liquidatable when health factor is slightly below 1.0", () => {
      const collateral = 100n * FIXED_POINT_SCALE;
      const debt = 85n * FIXED_POINT_SCALE + 1n; // Debt is slightly higher
      
      const hf = model.computeHealthFactor(collateral, debt);
      expect(hf).toBeLessThan(FIXED_POINT_SCALE);
      expect(model.isLiquidatable(collateral, debt)).toBe(true);
    });
  });
});
