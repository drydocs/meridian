import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import type { RawSelfRepayingLoanConfig } from "./config";
import { SelfRepayingLoanStrategy } from "./self-repaying-loan";

describe("SelfRepayingLoanStrategy", () => {
  const baseConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "XLM",
    borrowAsset: "USDC",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.from("0.50"), // 50% LTV
    deleverageBuffer: Decimal.from("0.05"),
    deleverageTargetLtv: Decimal.from("0.55"),
    liquidationThreshold: Decimal.from("0.75"), // 75% liquidation threshold
    liquidationPenalty: Decimal.from("0.08"),
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.from("0.05"), // 5%
    },
  };

  const strategy = new SelfRepayingLoanStrategy(baseConfig);

  describe("open", () => {
    it("correctly opens loan with hand-worked numbers and returns expected orders", () => {
      // 10,000 XLM collateral at $0.20/XLM = $2,000 collateral value
      // 50% LTV = $1,000 USDC borrow
      const collateralAmount = Decimal.from("10000");
      const collateralPrice = Decimal.from("0.20");

      const result = strategy.open({
        collateralAmount,
        collateralPrice,
      });

      expect(result.orders).toHaveLength(3);
      expect(result.orders[0]).toEqual({
        type: "supply_collateral",
        asset: "XLM",
        amount: collateralAmount,
      });
      expect(result.orders[1]).toEqual({
        type: "borrow",
        asset: "USDC",
        amount: Decimal.from("1000"),
      });
      expect(result.orders[2]).toEqual({
        type: "deploy_yield",
        asset: "USDC",
        amount: Decimal.from("1000"),
        target: "blend-pool",
      });

      expect(result.nextState.isOpen).toBe(true);
      expect(result.nextState.isClosed).toBe(false);
      expect(result.nextState.debtAmount.toString()).toBe("1000.0000000");
      expect(result.nextState.yieldDeployedPrincipal.toString()).toBe("1000.0000000");

      // Verify LTV matches opening LTV target exactly
      const currentLtv = strategy.computeCurrentLtv(result.nextState);
      expect(currentLtv.toString()).toBe("0.5000000");

      // Health factor: (2,000 * 0.75) / 1,000 = 1.50
      const hf = strategy.computeHealthFactor(result.nextState);
      expect(hf?.toString()).toBe("1.5000000");
    });

    it("rejects zero or negative collateral amount", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.zero(),
          collateralPrice: Decimal.from("0.20"),
        })
      ).toThrowError(RangeError);
    });
  });

  describe("amortize", () => {
    it("decreases debt over positive yield path until full repayment", () => {
      const { nextState: initialState } = strategy.open({
        collateralAmount: Decimal.from("10000"),
        collateralPrice: Decimal.from("0.20"),
      });

      // Periodic yield of $300, 0% period interest for clean accounting check
      const step1 = strategy.amortize({
        state: initialState,
        yieldAccrued: Decimal.from("300"),
      });

      expect(step1.nextState.debtAmount.toString()).toBe("700.0000000");
      expect(step1.nextState.totalYieldAmortized.toString()).toBe("300.0000000");
      expect(step1.orders).toHaveLength(2);
      expect(step1.orders[0]?.type).toBe("harvest_yield");
      expect(step1.orders[0]?.amount.toString()).toBe("300.0000000");
      expect(step1.orders[1]?.type).toBe("repay_debt");
      expect(step1.orders[1]?.amount.toString()).toBe("300.0000000");

      // Step 2: Another $300 yield
      const step2 = strategy.amortize({
        state: step1.nextState,
        yieldAccrued: Decimal.from("300"),
      });
      expect(step2.nextState.debtAmount.toString()).toBe("400.0000000");
      expect(step2.nextState.totalYieldAmortized.toString()).toBe("600.0000000");

      // Step 3: $500 yield (exceeds remaining $400 debt) -> repays exactly $400, leaving debt at 0
      const step3 = strategy.amortize({
        state: step2.nextState,
        yieldAccrued: Decimal.from("500"),
      });
      expect(step3.nextState.debtAmount.isZero()).toBe(true);
      expect(step3.nextState.totalYieldAmortized.toString()).toBe("1000.0000000");
      expect(step3.orders[0]?.amount.toString()).toBe("400.0000000");
      expect(step3.orders[1]?.amount.toString()).toBe("400.0000000");
    });

    it("accurately compounds borrow interest during amortization", () => {
      const { nextState: initialState } = strategy.open({
        collateralAmount: Decimal.from("10000"),
        collateralPrice: Decimal.from("0.20"),
      });

      // Debt = 1,000. 1% period interest -> +10 interest -> 1,010. Yield = 100 -> Debt = 910
      const step1 = strategy.amortize({
        state: initialState,
        yieldAccrued: Decimal.from("100"),
        borrowInterestRatePeriod: Decimal.from("0.01"),
      });

      expect(step1.nextState.debtAmount.toString()).toBe("910.0000000");
      expect(step1.nextState.totalInterestAccrued.toString()).toBe("10.0000000");
      expect(step1.nextState.totalYieldAmortized.toString()).toBe("100.0000000");
    });
  });

  describe("close", () => {
    it("unwinds yield position, repays remaining debt, and withdraws collateral", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.from("10000"),
        collateralPrice: Decimal.from("0.20"),
      });

      // Partial amortization leaving $600 debt
      const { nextState: amortizedState } = strategy.amortize({
        state: openState,
        yieldAccrued: Decimal.from("400"),
      });

      const closeResult = strategy.close({
        state: amortizedState,
      });

      expect(closeResult.orders).toHaveLength(3);
      expect(closeResult.orders[0]).toEqual({
        type: "withdraw_yield",
        asset: "USDC",
        amount: Decimal.from("1000"),
        target: "blend-pool",
      });
      expect(closeResult.orders[1]).toEqual({
        type: "repay_debt",
        asset: "USDC",
        amount: Decimal.from("600"),
      });
      expect(closeResult.orders[2]).toEqual({
        type: "withdraw_collateral",
        asset: "XLM",
        amount: Decimal.from("10000"),
      });

      expect(closeResult.nextState.isOpen).toBe(false);
      expect(closeResult.nextState.isClosed).toBe(true);
      expect(closeResult.nextState.debtAmount.isZero()).toBe(true);
      expect(closeResult.nextState.collateralAmount.isZero()).toBe(true);
      expect(closeResult.nextState.yieldDeployedPrincipal.isZero()).toBe(true);
    });

    it("rejects closing an already closed loan", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.from("10000"),
        collateralPrice: Decimal.from("0.20"),
      });

      const { nextState: closedState } = strategy.close({
        state: openState,
      });

      expect(() => strategy.close({ state: closedState })).toThrowError();
    });
  });
});
