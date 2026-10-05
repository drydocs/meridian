import { Decimal } from "./decimal";

export interface LoanProjectionInput {
  readonly initialDebt: Decimal;
  readonly deployedYieldPrincipal: Decimal;
  readonly assumedYieldRatePerPeriod: Decimal;
  readonly borrowInterestRatePerPeriod: Decimal;
  readonly costPerPeriod?: Decimal; // Fixed operational/fee/gas cost per period
  readonly maxPeriods?: number; // Maximum horizon to simulate (default: 1000)
}

export interface PeriodScheduleItem {
  readonly period: number;
  readonly debtStart: Decimal;
  readonly interestAccrued: Decimal;
  readonly costIncurred: Decimal;
  readonly grossYield: Decimal;
  readonly netYieldRepaid: Decimal;
  readonly debtEnd: Decimal;
}

export interface LoanProjectionResult {
  readonly breakEvenYieldRate: Decimal;
  /**
   * True when the assumed yield exceeds the break-even yield, i.e. the loan
   * mathematically self-repays. Independent of the simulated horizon.
   */
  readonly isRepayable: boolean;
  /**
   * Periods until the debt reaches zero. `undefined` when the loan never
   * repays, or when it is repayable but repayment runs past `maxPeriods`
   * (tell the two apart with `isRepayable`).
   */
  readonly timeToRepayPeriods: number | undefined;
  readonly schedule: PeriodScheduleItem[];
  readonly totalYieldGenerated: Decimal;
  readonly totalInterestPaid: Decimal;
  readonly totalCostPaid: Decimal;
}

/**
 * Computes the minimum break-even yield rate (per period) required for the loan to eventually repay.
 * Break-even condition:
 * Gross Yield >= Interest Accrued on initial debt + Periodic Costs
 * Principal * YieldRate >= InitialDebt * BorrowRate + CostPerPeriod
 * YieldRate >= (InitialDebt * BorrowRate + CostPerPeriod) / Principal
 */
export function computeBreakEvenYield(
  initialDebt: Decimal,
  deployedYieldPrincipal: Decimal,
  borrowInterestRate: Decimal,
  costPerPeriod: Decimal = Decimal.zero()
): Decimal {
  if (deployedYieldPrincipal.isZero()) {
    throw new RangeError(
      "Deployed yield principal cannot be zero when computing break-even yield"
    );
  }
  const interestCost = initialDebt.mul(borrowInterestRate);
  const totalCost = interestCost.add(costPerPeriod);
  return totalCost.div(deployedYieldPrincipal);
}

/**
 * Calculates the complete repayment schedule, time-to-repay, and break-even yield.
 */
export function computeLoanProjections(
  input: LoanProjectionInput
): LoanProjectionResult {
  const cost = input.costPerPeriod ?? Decimal.zero();
  const maxPeriods = input.maxPeriods ?? 1000;

  const breakEvenYield = computeBreakEvenYield(
    input.initialDebt,
    input.deployedYieldPrincipal,
    input.borrowInterestRatePerPeriod,
    cost
  );

  // If assumed yield is less than or equal to break-even yield, the loan will never self-repay
  const isRepayable = input.assumedYieldRatePerPeriod.gt(breakEvenYield);

  const schedule: PeriodScheduleItem[] = [];
  let debt = input.initialDebt;
  let timeToRepay: number | undefined = undefined;
  let totalYieldGenerated = Decimal.zero();
  let totalInterestPaid = Decimal.zero();
  let totalCostPaid = Decimal.zero();

  for (let period = 1; period <= maxPeriods; period++) {
    if (debt.isZero()) {
      break;
    }

    const debtStart = debt;
    const interestAccrued = debtStart.mul(input.borrowInterestRatePerPeriod);
    totalInterestPaid = totalInterestPaid.add(interestAccrued);

    const costIncurred = cost;
    totalCostPaid = totalCostPaid.add(costIncurred);

    const grossYield = input.deployedYieldPrincipal.mul(
      input.assumedYieldRatePerPeriod
    );
    totalYieldGenerated = totalYieldGenerated.add(grossYield);

    // Debt accumulates interest and cost
    const debtWithInterestAndCost = debtStart
      .add(interestAccrued)
      .add(costIncurred);

    let netYieldRepaid = Decimal.zero();
    let debtEnd = Decimal.zero();

    if (grossYield.gte(debtWithInterestAndCost)) {
      netYieldRepaid = debtWithInterestAndCost;
      debtEnd = Decimal.zero();
      debt = Decimal.zero();
      timeToRepay = period;
    } else {
      netYieldRepaid = grossYield;
      debtEnd = debtWithInterestAndCost.sub(grossYield);
      debt = debtEnd;
    }

    schedule.push({
      period,
      debtStart,
      interestAccrued,
      costIncurred,
      grossYield,
      netYieldRepaid,
      debtEnd,
    });

    if (debt.isZero()) {
      break;
    }
  }

  return {
    breakEvenYieldRate: breakEvenYield,
    isRepayable,
    timeToRepayPeriods: timeToRepay,
    schedule,
    totalYieldGenerated,
    totalInterestPaid,
    totalCostPaid,
  };
}
