import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import {
  computeBreakEvenYield,
  computeLoanProjections,
  LoanProjectionInput,
} from "./projections";

describe("Loan Projections", () => {
  it("computes break-even yield accurately", () => {
    // Initial Debt: $500, Deployed Principal: $500, Borrow Rate: 2% (0.02), Periodic Cost: $1
    // Interest = $500 * 0.02 = $10. Total Cost = $10 + $1 = $11
    // Break-even yield = $11 / $500 = 0.022 (2.2%)
    const breakEven = computeBreakEvenYield(
      Decimal.fromString("500"),
      Decimal.fromString("500"),
      Decimal.fromString("0.02"),
      Decimal.fromString("1.00")
    );
    expect(breakEven.toString()).toBe("0.0220000");
  });

  it("computes repayment schedule and time-to-repay when yield exceeds break-even", () => {
    // Debt: $100, Principal: $100, Borrow rate: 0%, Yield: 20% ($20 per period)
    // Schedule should reach zero in exactly 5 periods
    const input: LoanProjectionInput = {
      initialDebt: Decimal.fromString("100"),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.20"),
      borrowInterestRatePerPeriod: Decimal.zero(),
    };

    const result = computeLoanProjections(input);

    expect(result.isRepayable).toBe(true);
    expect(result.timeToRepayPeriods).toBe(5);
    expect(result.schedule).toHaveLength(5);
    expect(result.schedule[4]!.debtEnd.isZero()).toBe(true);
    expect(result.totalYieldGenerated.toString()).toBe("100.0000000");
  });

  it("handles interest accrual in multi-period schedule", () => {
    // Initial Debt: $100, Principal: $100, Yield: $30/period (30%), Borrow Rate: 10%/period (0.10)
    // Period 1: DebtStart = 100, Interest = 10, GrossYield = 30 -> NetRepaid = 30 -> DebtEnd = 110 - 30 = 80
    // Period 2: DebtStart = 80, Interest = 8, GrossYield = 30 -> DebtEnd = 88 - 30 = 58
    // Period 3: DebtStart = 58, Interest = 5.8, GrossYield = 30 -> DebtEnd = 63.8 - 30 = 33.8
    // Period 4: DebtStart = 33.8, Interest = 3.38, GrossYield = 30 -> DebtEnd = 37.18 - 30 = 7.18
    // Period 5: DebtStart = 7.18, Interest = 0.718, DebtTotal = 7.898, GrossYield = 30 -> DebtEnd = 0
    const input: LoanProjectionInput = {
      initialDebt: Decimal.fromString("100"),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.30"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.10"),
    };

    const result = computeLoanProjections(input);

    expect(result.isRepayable).toBe(true);
    expect(result.timeToRepayPeriods).toBe(5);
    expect(result.schedule).toHaveLength(5);
    expect(result.schedule[0]!.debtEnd.toString()).toBe("80.0000000");
    expect(result.schedule[1]!.debtEnd.toString()).toBe("58.0000000");
  });

  it("returns no finite time-to-repay when yield is at or below break-even", () => {
    // Borrow rate is 5%, assumed yield is 4% (below break-even)
    const input: LoanProjectionInput = {
      initialDebt: Decimal.fromString("500"),
      deployedYieldPrincipal: Decimal.fromString("500"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.04"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.05"),
      maxPeriods: 20,
    };

    const result = computeLoanProjections(input);

    expect(result.isRepayable).toBe(false);
    expect(result.timeToRepayPeriods).toBeUndefined();
    expect(result.schedule).toHaveLength(20);
    // Debt grows rather than repays
    expect(result.schedule[19]!.debtEnd.gt(input.initialDebt)).toBe(true);
  });

  it("stays repayable when repayment runs past the simulated horizon", () => {
    // Yield 6% beats the 5% break-even, so the loan self-repays, but only
    // slowly: the 20-period horizon ends with debt still outstanding.
    const input: LoanProjectionInput = {
      initialDebt: Decimal.fromString("500"),
      deployedYieldPrincipal: Decimal.fromString("500"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.06"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.05"),
      maxPeriods: 20,
    };

    const result = computeLoanProjections(input);

    expect(result.isRepayable).toBe(true);
    expect(result.timeToRepayPeriods).toBeUndefined();
    expect(result.schedule).toHaveLength(20);
    expect(result.schedule[19]!.debtEnd.isZero()).toBe(false);
    expect(result.schedule[19]!.debtEnd.lt(input.initialDebt)).toBe(true);
  });

  it("reports a diverging loan as not repayable", () => {
    const result = computeLoanProjections({
      initialDebt: Decimal.fromString("500"),
      deployedYieldPrincipal: Decimal.fromString("500"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.05"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.05"),
      maxPeriods: 20,
    });

    expect(result.isRepayable).toBe(false);
    expect(result.timeToRepayPeriods).toBeUndefined();
  });
});
