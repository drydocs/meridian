import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import type { RawSelfRepayingLoanConfig } from "./config";
import { SelfRepayingLoanStrategy } from "./self-repaying-loan";

describe("SelfRepayingLoanStrategy", () => {
  const baseConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "XLM",
    borrowAsset: "USDC",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.fromString("0.50"), // 50% LTV
    deleverageBuffer: Decimal.fromString("0.05"),
    deleverageTargetLtv: Decimal.fromString("0.55"),
    liquidationThreshold: Decimal.fromString("0.75"), // 75% liquidation threshold
    liquidationPenalty: Decimal.fromString("0.08"),
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.fromString("0.05"), // 5%
    },
  };

  const strategy = new SelfRepayingLoanStrategy(baseConfig);

  describe("open", () => {
    it("correctly opens loan with hand-worked numbers and returns expected orders", () => {
      // 10,000 XLM collateral at $0.20/XLM = $2,000 collateral value
      // 50% LTV = $1,000 USDC borrow
      const collateralAmount = Decimal.fromString("10000");
      const collateralPrice = Decimal.fromString("0.20");

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
        amount: Decimal.fromString("1000"),
      });
      expect(result.orders[2]).toEqual({
        type: "deploy_yield",
        asset: "USDC",
        amount: Decimal.fromString("1000"),
        target: "blend-pool",
      });

      expect(result.nextState.isOpen).toBe(true);
      expect(result.nextState.isClosed).toBe(false);
      expect(result.nextState.debtAmount.toString()).toBe("1000.0000000");
      expect(result.nextState.yieldDeployedPrincipal.toString()).toBe(
        "1000.0000000"
      );

      // Verify LTV matches opening LTV target exactly
      const currentLtv = strategy.computeCurrentLtv(result.nextState);
      expect(currentLtv?.toString()).toBe("0.5000000");

      // Health factor: (2,000 * 0.75) / 1,000 = 1.50
      const hf = strategy.computeHealthFactor(result.nextState);
      expect(hf?.toString()).toBe("1.5000000");
    });

    it("rejects zero or negative collateral amount", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.zero(),
          collateralPrice: Decimal.fromString("0.20"),
        })
      ).toThrowError(RangeError);
    });

    it("rejects non-positive collateral and borrow prices", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.fromString("10000"),
          collateralPrice: Decimal.zero(),
        })
      ).toThrowError(/Collateral price must be strictly positive/);

      expect(() =>
        strategy.open({
          collateralAmount: Decimal.fromString("10000"),
          collateralPrice: Decimal.fromString("0.20"),
          borrowAssetPrice: Decimal.fromString("-1"),
        })
      ).toThrowError(/Borrow asset price must be strictly positive/);
    });

    it("rejects collateral too small to borrow against", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.fromString("0.1"),
          collateralPrice: Decimal.fromString("0.0000001"),
        })
      ).toThrowError(/Borrow amount calculated to zero/);
    });
  });

  describe("amortize", () => {
    it("decreases debt over positive yield path until full repayment", () => {
      const { nextState: initialState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      // Periodic yield of $300, 0% period interest for clean accounting check
      const step1 = strategy.amortize({
        state: initialState,
        yieldAccrued: Decimal.fromString("300"),
      });

      expect(step1.nextState.debtAmount.toString()).toBe("700.0000000");
      expect(step1.nextState.totalYieldAmortized.toString()).toBe(
        "300.0000000"
      );
      expect(step1.orders).toHaveLength(2);
      expect(step1.orders[0]?.type).toBe("harvest_yield");
      expect(step1.orders[0]?.amount.toString()).toBe("300.0000000");
      expect(step1.orders[1]?.type).toBe("repay_debt");
      expect(step1.orders[1]?.amount.toString()).toBe("300.0000000");

      // Step 2: Another $300 yield
      const step2 = strategy.amortize({
        state: step1.nextState,
        yieldAccrued: Decimal.fromString("300"),
      });
      expect(step2.nextState.debtAmount.toString()).toBe("400.0000000");
      expect(step2.nextState.totalYieldAmortized.toString()).toBe(
        "600.0000000"
      );

      // Step 3: $500 yield (exceeds remaining $400 debt) -> repays exactly $400, leaving debt at 0
      const step3 = strategy.amortize({
        state: step2.nextState,
        yieldAccrued: Decimal.fromString("500"),
      });
      expect(step3.nextState.debtAmount.isZero()).toBe(true);
      expect(step3.nextState.totalYieldAmortized.toString()).toBe(
        "1000.0000000"
      );
      expect(step3.orders[0]?.amount.toString()).toBe("400.0000000");
      expect(step3.orders[1]?.amount.toString()).toBe("400.0000000");
    });

    it("accurately compounds borrow interest during amortization", () => {
      const { nextState: initialState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      // Debt = 1,000. 1% period interest -> +10 interest -> 1,010. Yield = 100 -> Debt = 910
      const step1 = strategy.amortize({
        state: initialState,
        yieldAccrued: Decimal.fromString("100"),
        borrowInterestRatePeriod: Decimal.fromString("0.01"),
      });

      expect(step1.nextState.debtAmount.toString()).toBe("910.0000000");
      expect(step1.nextState.totalInterestAccrued.toString()).toBe(
        "10.0000000"
      );
      expect(step1.nextState.totalYieldAmortized.toString()).toBe(
        "100.0000000"
      );
    });

    it("rejects negative yield, a negative period rate, and a non-positive collateral price", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      expect(() =>
        strategy.amortize({
          state: openState,
          yieldAccrued: Decimal.fromString("-1"),
        })
      ).toThrowError(/Yield accrued cannot be negative/);

      expect(() =>
        strategy.amortize({
          state: openState,
          yieldAccrued: Decimal.fromString("10"),
          borrowInterestRatePeriod: Decimal.fromString("-0.01"),
        })
      ).toThrowError(/Borrow interest rate cannot be negative/);

      expect(() =>
        strategy.amortize({
          state: openState,
          yieldAccrued: Decimal.fromString("10"),
          collateralPrice: Decimal.zero(),
        })
      ).toThrowError(/Collateral price must be strictly positive/);
    });

    it("rejects amortizing a loan that is not open", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      const { nextState: closedState } = strategy.close({ state: openState });

      expect(() =>
        strategy.amortize({
          state: closedState,
          yieldAccrued: Decimal.fromString("10"),
        })
      ).toThrowError(/Cannot amortize a closed or uninitialized loan/);
    });
  });

  describe("risk metrics", () => {
    it("reports no finite LTV when collateral value is gone but debt remains", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      const wipedOut = { ...openState, collateralAmount: Decimal.zero() };

      expect(strategy.computeCurrentLtv(wipedOut)).toBeUndefined();
      // Zero collateral against live debt is liquidatable, and the health
      // factor agrees with the missing LTV rather than inventing a ratio.
      expect(strategy.computeHealthFactor(wipedOut)?.toString()).toBe(
        "0.0000000"
      );

      const debtFree = { ...wipedOut, debtAmount: Decimal.zero() };
      expect(strategy.computeCurrentLtv(debtFree)?.toString()).toBe(
        "0.0000000"
      );
      expect(strategy.computeHealthFactor(debtFree)).toBeUndefined();
    });
  });

  describe("close", () => {
    it("unwinds yield position, repays remaining debt, and withdraws collateral", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      // Partial amortization leaving $600 debt
      const { nextState: amortizedState } = strategy.amortize({
        state: openState,
        yieldAccrued: Decimal.fromString("400"),
      });

      const closeResult = strategy.close({
        state: amortizedState,
      });

      expect(closeResult.orders).toHaveLength(3);
      expect(closeResult.orders[0]).toEqual({
        type: "withdraw_yield",
        asset: "USDC",
        amount: Decimal.fromString("1000"),
        target: "blend-pool",
      });
      expect(closeResult.orders[1]).toEqual({
        type: "repay_debt",
        asset: "USDC",
        amount: Decimal.fromString("600"),
      });
      expect(closeResult.orders[2]).toEqual({
        type: "withdraw_collateral",
        asset: "XLM",
        amount: Decimal.fromString("10000"),
      });

      expect(closeResult.nextState.isOpen).toBe(false);
      expect(closeResult.nextState.isClosed).toBe(true);
      expect(closeResult.nextState.debtAmount.isZero()).toBe(true);
      expect(closeResult.nextState.collateralAmount.isZero()).toBe(true);
      expect(closeResult.nextState.yieldDeployedPrincipal.isZero()).toBe(true);
    });

    it("rejects closing an already closed loan", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      const { nextState: closedState } = strategy.close({
        state: openState,
      });

      expect(() => strategy.close({ state: closedState })).toThrowError();
    });

    it("rejects a close the deployed principal cannot repay", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      // A 10% period charge with no harvested yield pushes debt past the $1,000
      // deployed principal, which is the strategy's only repayment source.
      const { nextState: underwater } = strategy.amortize({
        state: openState,
        yieldAccrued: Decimal.zero(),
        borrowInterestRatePeriod: Decimal.fromString("0.10"),
      });

      expect(underwater.debtAmount.toString()).toBe("1100.0000000");
      expect(() => strategy.close({ state: underwater })).toThrowError(
        /debt 1100\.0000000 exceeds repayable funds 1000\.0000000 by 100\.0000000/
      );
      expect(() =>
        strategy.close({
          state: underwater,
          additionalRepayment: Decimal.fromString("-1"),
        })
      ).toThrowError(/Additional repayment cannot be negative/);
    });

    it("skips the repay order once amortization has cleared the debt", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      const { nextState: repaid } = strategy.amortize({
        state: openState,
        yieldAccrued: Decimal.fromString("1000"),
      });

      expect(repaid.debtAmount.isZero()).toBe(true);

      const closeResult = strategy.close({ state: repaid });

      expect(closeResult.orders).toHaveLength(2);
      expect(closeResult.orders[0]?.type).toBe("withdraw_yield");
      expect(closeResult.orders[1]?.type).toBe("withdraw_collateral");
      expect(closeResult.nextState.isClosed).toBe(true);
    });

    it("closes once the borrower covers the shortfall", () => {
      const { nextState: openState } = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });

      const { nextState: underwater } = strategy.amortize({
        state: openState,
        yieldAccrued: Decimal.zero(),
        borrowInterestRatePeriod: Decimal.fromString("0.10"),
      });

      const closeResult = strategy.close({
        state: underwater,
        additionalRepayment: Decimal.fromString("100"),
      });

      expect(closeResult.nextState.isClosed).toBe(true);
      expect(closeResult.nextState.debtAmount.isZero()).toBe(true);
      expect(closeResult.orders).toHaveLength(3);
      expect(closeResult.orders[1]?.type).toBe("repay_debt");
      expect(closeResult.orders[1]?.amount.toString()).toBe("1100.0000000");
      expect(closeResult.orders[2]?.type).toBe("withdraw_collateral");
    });
  });
});
