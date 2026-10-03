import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";
import { MultiCollateralBasket, CollateralPosition } from "./multi-collateral";

describe("MultiCollateralBasket", () => {
  const usdcModel = new LiquidationParameterModel({
    maxLoanToValue: Decimal.fromString("0.80"), // 80%
    liquidationThreshold: Decimal.fromString("0.85"), // 85%
    liquidationPenalty: Decimal.fromString("0.05"), // 5%
  });

  const xlmModel = new LiquidationParameterModel({
    maxLoanToValue: Decimal.fromString("0.60"), // 60%
    liquidationThreshold: Decimal.fromString("0.70"), // 70%
    liquidationPenalty: Decimal.fromString("0.10"), // 10%
  });

  it("should throw if initialized with an empty positions array", () => {
    expect(() => new MultiCollateralBasket({ positions: [] })).toThrow(
      RangeError
    );
  });

  it("should calculate single-collateral metrics with identical results", () => {
    // Single collateral: 100 USDC at $1.00 = $100 value
    const pos: CollateralPosition = {
      asset: "USDC",
      amount: Decimal.fromString("100"),
      price: Decimal.fromString("1.00"),
      liquidationModel: usdcModel,
    };

    const basket = new MultiCollateralBasket({ positions: [pos] });

    expect(basket.computeTotalCollateralValue().toString()).toBe("100.0000000");
    expect(basket.computeBlendedLiquidationThreshold().toString()).toBe(
      "0.8500000"
    );
    expect(basket.computeBlendedMaxLoanToValue().toString()).toBe("0.8000000");

    // Debt = 50 USDC -> HF = (100 * 0.85) / 50 = 1.7
    const debt = Decimal.fromString("50");
    const hf = basket.computeHealthFactor(debt);
    expect(hf?.toString()).toBe("1.7000000");
  });

  it("should compute blended health factor for multi-asset basket accurately", () => {
    // 100 USDC at $1 = $100 (Threshold 85% -> $85 discounted)
    // 500 XLM at $0.20 = $100 (Threshold 70% -> $70 discounted)
    // Total Collateral = $200
    // Total Discounted Collateral = $85 + $70 = $155
    // Blended Threshold = 155 / 200 = 0.775 (77.5%)
    // Debt = $100 -> Blended HF = 155 / 100 = 1.55
    const positions: CollateralPosition[] = [
      {
        asset: "USDC",
        amount: Decimal.fromString("100"),
        price: Decimal.fromString("1.00"),
        liquidationModel: usdcModel,
      },
      {
        asset: "XLM",
        amount: Decimal.fromString("500"),
        price: Decimal.fromString("0.20"),
        liquidationModel: xlmModel,
      },
    ];

    const basket = new MultiCollateralBasket({ positions });

    expect(basket.computeTotalCollateralValue().toString()).toBe("200.0000000");
    expect(basket.computeBlendedLiquidationThreshold().toString()).toBe(
      "0.7750000"
    );
    expect(basket.computeBlendedMaxLoanToValue().toString()).toBe("0.7000000"); // (80 + 60) / 2 = 70%

    const debt = Decimal.fromString("100");
    const hf = basket.computeHealthFactor(debt);
    expect(hf?.toString()).toBe("1.5500000");
  });

  it("should handle zero total value gracefully for threshold and LTV", () => {
    const basket = new MultiCollateralBasket({
      positions: [
        {
          asset: "ZERO",
          amount: Decimal.zero(),
          price: Decimal.zero(),
          liquidationModel: usdcModel,
        },
      ],
    });
    expect(basket.computeTotalCollateralValue().isZero()).toBe(true);
    expect(basket.computeBlendedLiquidationThreshold().isZero()).toBe(true);
    expect(basket.computeBlendedMaxLoanToValue().isZero()).toBe(true);
  });

  it("should return undefined health factor when debt is zero", () => {
    const basket = new MultiCollateralBasket({
      positions: [
        {
          asset: "USDC",
          amount: Decimal.fromString("100"),
          price: Decimal.fromString("1.00"),
          liquidationModel: usdcModel,
        },
      ],
    });
    expect(basket.computeHealthFactor(Decimal.zero())).toBeUndefined();
  });

  describe("deleverage ordering policy", () => {
    const positions: CollateralPosition[] = [
      {
        asset: "USDC",
        amount: Decimal.fromString("100"),
        price: Decimal.fromString("1.00"),
        liquidationModel: usdcModel, // Threshold 85%, Penalty 5%
      },
      {
        asset: "XLM",
        amount: Decimal.fromString("500"),
        price: Decimal.fromString("0.20"),
        liquidationModel: xlmModel, // Threshold 70%, Penalty 10%
      },
    ];

    it("should return empty deleverage plan when debt repayment <= 0", () => {
      const basket = new MultiCollateralBasket({ positions });
      expect(basket.computeDeleveragePlan(Decimal.zero())).toEqual([]);
      expect(basket.computeDeleveragePlan(Decimal.fromString("-10"))).toEqual(
        []
      );
    });

    it("should unwind highest-risk-first (lowest liquidation threshold first)", () => {
      const basket = new MultiCollateralBasket({
        positions,
        deleveragePolicy: "highest-risk-first",
      });

      // Need to repay $50 of debt
      // XLM has threshold 70% (lower than USDC 85%), so XLM is unwound first.
      // XLM value = $100. Repaying $50 requires unwinding $50 / $0.20 = 250 XLM.
      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));
      expect(plan).toHaveLength(1);
      expect(plan[0]!.asset).toBe("XLM");
      expect(plan[0]!.amountToUnwind.toString()).toBe("250.0000000");
      expect(plan[0]!.debtRepaidValue.toString()).toBe("50.0000000");
    });

    it("should exhaust first asset and draw from second when repayment exceeds first position", () => {
      const basket = new MultiCollateralBasket({
        positions,
        deleveragePolicy: "highest-risk-first",
      });

      // Need to repay $150 of debt
      // 1. XLM (total $100 value -> 500 XLM)
      // 2. USDC (remaining $50 value -> 50 USDC)
      const plan = basket.computeDeleveragePlan(Decimal.fromString("150"));
      expect(plan).toHaveLength(2);
      expect(plan[0]!.asset).toBe("XLM");
      expect(plan[0]!.amountToUnwind.toString()).toBe("500.0000000");
      expect(plan[0]!.debtRepaidValue.toString()).toBe("100.0000000");

      expect(plan[1]!.asset).toBe("USDC");
      expect(plan[1]!.amountToUnwind.toString()).toBe("50.0000000");
      expect(plan[1]!.debtRepaidValue.toString()).toBe("50.0000000");
    });

    it("should unwind lowest-liquidity-penalty-first", () => {
      const basket = new MultiCollateralBasket({
        positions,
        deleveragePolicy: "lowest-liquidity-penalty-first",
      });

      // USDC has penalty 5% vs XLM 10%, so USDC is unwound first.
      // Need to repay $50 of debt -> 50 USDC.
      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));
      expect(plan).toHaveLength(1);
      expect(plan[0]!.asset).toBe("USDC");
      expect(plan[0]!.amountToUnwind.toString()).toBe("50.0000000");
      expect(plan[0]!.debtRepaidValue.toString()).toBe("50.0000000");
    });

    it("should unwind pro-rata across positions", () => {
      const basket = new MultiCollateralBasket({
        positions,
        deleveragePolicy: "pro-rata",
      });

      // Both positions have $100 value each (50% each)
      // Repaying $50 debt -> $25 from USDC (25 USDC), $25 from XLM (125 XLM)
      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));
      expect(plan).toHaveLength(2);
      expect(plan[0]!.asset).toBe("USDC");
      expect(plan[0]!.amountToUnwind.toString()).toBe("25.0000000");
      expect(plan[1]!.asset).toBe("XLM");
      expect(plan[1]!.amountToUnwind.toString()).toBe("125.0000000");
    });
  });
});
