import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import {
  computeBreakEvenYield,
  computeLoanProjections,
  type LoanProjectionInput,
} from "./projections";

describe("computeBreakEvenYield", () => {
  it("computes the break-even yield with hand-worked figures", () => {
    // Debt $500, principal $500, borrow rate 2% -> interest $10
    // Plus $1 periodic cost -> total $11; break-even = 11 / 500 = 0.022
    const breakEven = computeBreakEvenYield(
      Decimal.fromString("500"),
      Decimal.fromString("500"),
      Decimal.fromString("0.02"),
      Decimal.fromString("1.00")
    );
    expect(breakEven.toString()).toBe("0.0220000");
  });

  it("excludes cost when none is given", () => {
    // Debt $200, principal $400, rate 5% -> interest $10; 10 / 400 = 0.025
    const breakEven = computeBreakEvenYield(
      Decimal.fromString("200"),
      Decimal.fromString("400"),
      Decimal.fromString("0.05")
    );
    expect(breakEven.toString()).toBe("0.0250000");
  });

  it("is zero for an interest-free, cost-free loan", () => {
    const breakEven = computeBreakEvenYield(
      Decimal.fromString("500"),
      Decimal.fromString("500"),
      Decimal.zero()
    );
    expect(breakEven.isZero()).toBe(true);
  });

  it("rejects a zero deployed principal", () => {
    expect(() =>
      computeBreakEvenYield(
        Decimal.fromString("500"),
        Decimal.zero(),
        Decimal.fromString("0.02")
      )
    ).toThrowError(RangeError);
  });
});

describe("computeLoanProjections", () => {
  // Interest-free $500 debt with a fixed $10/period cost:
  // break-even yield = 10 / 500 = 0.02 (2% per period)
  const baseInput: LoanProjectionInput = {
    initialDebt: Decimal.fromString("500"),
    deployedYieldPrincipal: Decimal.fromString("500"),
    assumedYieldRatePerPeriod: Decimal.fromString("0.02"),
    borrowInterestRatePerPeriod: Decimal.zero(),
    costPerPeriod: Decimal.fromString("10"),
  };

  it("does not repay below the break-even yield", () => {
    // 1% yield = $5/period against $10 of cost: debt grows $5/period
    const result = computeLoanProjections({
      ...baseInput,
      assumedYieldRatePerPeriod: Decimal.fromString("0.01"),
      maxPeriods: 20,
    });

    expect(result.isRepayable).toBe(false);
    expect(result.timeToRepayPeriods).toBeUndefined();
    expect(result.schedule).toHaveLength(20);
    // Debt: 500 -> 505 -> ... -> 600 after 20 periods
    expect(result.schedule[0]!.debtEnd.toString()).toBe("505.0000000");
    expect(result.schedule[19]!.debtEnd.toString()).toBe("600.0000000");
    expect(result.totalCostPaid.toString()).toBe("200.0000000");
    expect(result.totalYieldGenerated.toString()).toBe("100.0000000");
  });

  it("does not repay exactly at the break-even yield (boundary)", () => {
    // 2% yield = $10/period exactly covers the $10 cost: debt stays flat
    const result = computeLoanProjections({
      ...baseInput,
      assumedYieldRatePerPeriod: Decimal.fromString("0.02"),
      maxPeriods: 15,
    });

    expect(result.isRepayable).toBe(false);
    expect(result.timeToRepayPeriods).toBeUndefined();
    expect(result.schedule).toHaveLength(15);
    expect(
      result.schedule.every((s) => s.debtEnd.toString() === "500.0000000")
    ).toBe(true);
  });

  it("repays above the break-even yield and reports time-to-repay", () => {
    // 13% yield = $65/period against $10 cost: net progress $55/period
    // 500 -> 445 -> 390 -> 335 -> 280 -> 225 -> 170 -> 115 -> 60 -> 5;
    // period 10: 5 + 10 cost = 15 <= 65 -> repaid exactly in period 10
    const result = computeLoanProjections({
      ...baseInput,
      assumedYieldRatePerPeriod: Decimal.fromString("0.13"),
    });

    expect(result.isRepayable).toBe(true);
    expect(result.timeToRepayPeriods).toBe(10);
    expect(result.schedule).toHaveLength(10);
    expect(result.schedule[9]!.debtStart.toString()).toBe("5.0000000");
    expect(result.schedule[9]!.netYieldRepaid.toString()).toBe("15.0000000");
    expect(result.schedule[9]!.debtEnd.isZero()).toBe(true);
    expect(result.totalInterestPaid.isZero()).toBe(true);
    expect(result.totalCostPaid.toString()).toBe("100.0000000");
    // Gross yield accrues every period whether or not it is needed:
    // 10 periods x $65 = $650 (only $585 + the final $15 was actually used).
    expect(result.totalYieldGenerated.toString()).toBe("650.0000000");
  });

  it("repays in one period when yield covers the whole debt", () => {
    // Debt $100 at 10% -> $110 due; yield $200 covers it immediately
    const result = computeLoanProjections({
      initialDebt: Decimal.fromString("100"),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("2.00"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.10"),
      maxPeriods: 10,
    });

    expect(result.isRepayable).toBe(true);
    expect(result.timeToRepayPeriods).toBe(1);
    expect(result.schedule).toHaveLength(1);
    expect(result.schedule[0]!.interestAccrued.toString()).toBe("10.0000000");
    expect(result.schedule[0]!.netYieldRepaid.toString()).toBe("110.0000000");
    expect(result.totalYieldGenerated.toString()).toBe("200.0000000");
    expect(result.totalInterestPaid.toString()).toBe("10.0000000");
  });

  it("walks a multi-period schedule with compounding interest", () => {
    // Debt $100, principal $100, yield $30/period, borrow rate 10%/period
    // P1: 100 + 10 = 110; repay 30 -> 80
    // P2: 80 + 8 = 88; repay 30 -> 58
    // P3: 58 + 5.8 = 63.8; repay 30 -> 33.8
    // P4: 33.8 + 3.38 = 37.18; repay 30 -> 7.18
    // P5: 7.18 + 0.718 = 7.898 <= 30 -> repaid
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
    expect(result.schedule[0]!.debtStart.toString()).toBe("100.0000000");
    expect(result.schedule[0]!.interestAccrued.toString()).toBe("10.0000000");
    expect(result.schedule[0]!.debtEnd.toString()).toBe("80.0000000");
    expect(result.schedule[1]!.debtStart.toString()).toBe("80.0000000");
    expect(result.schedule[1]!.interestAccrued.toString()).toBe("8.0000000");
    expect(result.schedule[1]!.debtEnd.toString()).toBe("58.0000000");
    expect(result.schedule[3]!.debtEnd.toString()).toBe("7.1800000");
    expect(result.schedule[4]!.netYieldRepaid.toString()).toBe("7.8980000");
    // 10 + 8 + 5.8 + 3.38 + 0.718
    expect(result.totalInterestPaid.toString()).toBe("27.8980000");
  });

  it("adds a fixed cost to the debt each period", () => {
    // Debt $100, no interest, yield $30/period, cost $10/period:
    // net progress $20/period -> repaid in 5 periods; the last period
    // repays exactly 20 + 10 = 30 (yield == debt due, boundary)
    const result = computeLoanProjections({
      initialDebt: Decimal.fromString("100"),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.30"),
      borrowInterestRatePerPeriod: Decimal.zero(),
      costPerPeriod: Decimal.fromString("10"),
    });

    expect(result.isRepayable).toBe(true);
    expect(result.timeToRepayPeriods).toBe(5);
    expect(result.schedule[0]!.costIncurred.toString()).toBe("10.0000000");
    expect(result.schedule[0]!.debtEnd.toString()).toBe("80.0000000");
    expect(result.schedule[4]!.debtStart.toString()).toBe("20.0000000");
    expect(result.schedule[4]!.netYieldRepaid.toString()).toBe("30.0000000");
    expect(result.totalCostPaid.toString()).toBe("50.0000000");
  });

  it("records gross yield every period and totals it", () => {
    // Debt $100, yield $20/period, no interest or cost: repaid in 5 periods
    const result = computeLoanProjections({
      initialDebt: Decimal.fromString("100"),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.20"),
      borrowInterestRatePerPeriod: Decimal.zero(),
    });

    expect(
      result.schedule.every((s) => s.grossYield.toString() === "20.0000000")
    ).toBe(true);
    expect(result.totalYieldGenerated.toString()).toBe("100.0000000");
    expect(result.totalInterestPaid.isZero()).toBe(true);
    expect(result.totalCostPaid.isZero()).toBe(true);
  });

  it("returns an empty schedule for zero initial debt", () => {
    const result = computeLoanProjections({
      initialDebt: Decimal.zero(),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.20"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.02"),
    });

    expect(result.schedule).toHaveLength(0);
    expect(result.isRepayable).toBe(false);
    expect(result.timeToRepayPeriods).toBeUndefined();
    expect(result.totalYieldGenerated.isZero()).toBe(true);
    expect(result.totalInterestPaid.isZero()).toBe(true);
  });

  it("stops simulating after maxPeriods even when repayable", () => {
    // 11% yield = $11/period against 1% interest on $1000 ($10): the debt
    // shrinks only slowly, and 30 periods cannot clear $1000.
    const result = computeLoanProjections({
      initialDebt: Decimal.fromString("1000"),
      deployedYieldPrincipal: Decimal.fromString("100"),
      assumedYieldRatePerPeriod: Decimal.fromString("0.11"),
      borrowInterestRatePerPeriod: Decimal.fromString("0.01"),
      maxPeriods: 30,
    });

    expect(result.schedule).toHaveLength(30);
    expect(result.isRepayable).toBe(false);
    expect(result.timeToRepayPeriods).toBeUndefined();
    expect(result.schedule[29]!.debtEnd.isZero()).toBe(false);
  });
});
