import { Decimal } from "./decimal";

export interface LoanProjectionInput {
  readonly initialDebt: Decimal;
  readonly deployedYieldPrincipal: Decimal;
  readonly assumedYieldRatePerPeriod: Decimal;
  readonly borrowInterestRatePerPeriod: Decimal;
  /**
   * Flat fee and gas cost charged each period, in the borrow asset. Derive it
   * from the cost schedule in `costs.ts` (swap fee plus network fee). Defaults
   * to zero.
   */
  readonly costPerPeriod?: Decimal;
  /** Maximum horizon to simulate. Must be a positive integer. Defaults to 1000. */
  readonly maxPeriods?: number;
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
   * Periods until the debt reaches zero, `0` when the opening debt is already
   * zero. `undefined` when the loan never repays, or when it is repayable but
   * repayment runs past `maxPeriods` (tell the two apart with `isRepayable`).
   */
  readonly timeToRepayPeriods: number | undefined;
  readonly schedule: PeriodScheduleItem[];
  readonly totalYieldGenerated: Decimal;
  readonly totalInterestPaid: Decimal;
  readonly totalCostPaid: Decimal;
}

function validateInputs(
  initialDebt: Decimal,
  deployedYieldPrincipal: Decimal,
  borrowInterestRate: Decimal,
  costPerPeriod: Decimal
): void {
  if (!deployedYieldPrincipal.isPositive()) {
    throw new RangeError(
      `Deployed yield principal must be positive, got ${deployedYieldPrincipal.toString()}`
    );
  }
  if (initialDebt.isNegative()) {
    throw new RangeError(
      `Initial debt cannot be negative, got ${initialDebt.toString()}`
    );
  }
  if (borrowInterestRate.isNegative()) {
    throw new RangeError(
      `Borrow interest rate cannot be negative, got ${borrowInterestRate.toString()}`
    );
  }
  if (costPerPeriod.isNegative()) {
    throw new RangeError(
      `Cost per period cannot be negative, got ${costPerPeriod.toString()}`
    );
  }
}

/**
 * Computes the minimum break-even yield rate (per period) required for the loan to eventually repay.
 * Break-even condition:
 * Gross Yield >= Interest Accrued on initial debt + Periodic Costs
 * Principal * YieldRate >= InitialDebt * BorrowRate + CostPerPeriod
 * YieldRate >= (InitialDebt * BorrowRate + CostPerPeriod) / Principal
 *
 * @throws RangeError when the deployed yield principal is not positive, or when
 * a monetary input is negative.
 */
export function computeBreakEvenYield(
  initialDebt: Decimal,
  deployedYieldPrincipal: Decimal,
  borrowInterestRate: Decimal,
  costPerPeriod: Decimal = Decimal.zero()
): Decimal {
  validateInputs(
    initialDebt,
    deployedYieldPrincipal,
    borrowInterestRate,
    costPerPeriod
  );
  const interestCost = initialDebt.mul(borrowInterestRate);
  const totalCost = interestCost.add(costPerPeriod);
  return totalCost.div(deployedYieldPrincipal);
}

/**
 * Calculates the complete repayment schedule, time-to-repay, and break-even yield.
 *
 * @throws RangeError when the deployed yield principal is not positive, when a
 * monetary input is negative, or when `maxPeriods` is not a positive integer.
 */
export function computeLoanProjections(
  input: LoanProjectionInput
): LoanProjectionResult {
  const cost = input.costPerPeriod ?? Decimal.zero();
  const maxPeriods = input.maxPeriods ?? 1000;

  if (!Number.isInteger(maxPeriods) || maxPeriods < 1) {
    throw new RangeError(
      `maxPeriods must be a positive integer, got ${maxPeriods}`
    );
  }

  const breakEvenYield = computeBreakEvenYield(
    input.initialDebt,
    input.deployedYieldPrincipal,
    input.borrowInterestRatePerPeriod,
    cost
  );

  // Zero opening debt is already repaid, so there is nothing to schedule
  if (input.initialDebt.isZero()) {
    return {
      breakEvenYieldRate: breakEvenYield,
      isRepayable: true,
      timeToRepayPeriods: 0,
      schedule: [],
      totalYieldGenerated: Decimal.zero(),
      totalInterestPaid: Decimal.zero(),
      totalCostPaid: Decimal.zero(),
    };
  }

  // If assumed yield is less than or equal to break-even yield, the loan will never self-repay
  const isRepayable = input.assumedYieldRatePerPeriod.gt(breakEvenYield);

  const schedule: PeriodScheduleItem[] = [];
  let debt = input.initialDebt;
  let timeToRepay: number | undefined = undefined;
  let totalYieldGenerated = Decimal.zero();
  let totalInterestPaid = Decimal.zero();
  let totalCostPaid = Decimal.zero();

  for (let period = 1; period <= maxPeriods; period++) {
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
