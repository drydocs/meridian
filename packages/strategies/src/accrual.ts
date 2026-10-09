import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";
import type { FundingPosition, FundingRate } from "./types";

/** Basis for annualized borrow rates, a 365-day year. */
export const YEAR_MILLISECONDS = 365n * 24n * 60n * 60n * 1000n;

/** A `FundingRate` is quoted per second, so its accrual period is one second. */
const MILLISECONDS_PER_FUNDING_PERIOD = 1_000n;

export interface PortfolioState {
  readonly cash: FixedPointDecimal;
  readonly debt: FixedPointDecimal;
  readonly equity: FixedPointDecimal;
  /**
   * Fractional-stroop accrual carried between ticks, keyed `borrow:<id>` or
   * `funding:<id>`. Only positions present on the tick keep an entry.
   */
  readonly accrualRemainders: Readonly<Record<string, bigint>>;
}

export type PortfolioTransaction =
  | { readonly type: "borrow-interest"; readonly amount: FixedPointDecimal }
  | {
      /** Signed cash flow to the portfolio, so a credit is positive. */
      readonly type: "funding-payment";
      readonly amount: FixedPointDecimal;
    };

export interface BorrowAccrualPosition {
  readonly id: string;
  /**
   * Debt to accrue on this tick. Re-supply the balance after the previous
   * tick's accrual to compound; a fixed value models simple interest.
   */
  readonly outstandingDebt: FixedPointDecimal;
  /** Annualized and non-negative. */
  readonly annualRate: FixedPointDecimal;
}

export interface FundingAccrualPosition extends FundingPosition {
  readonly id: string;
  /**
   * Signed rate from the position's own perspective, using the convention
   * #864 documents for `FundingRate`. A positive rate credits the position and
   * a negative rate debits it.
   */
  readonly rate: FundingRate;
}

export interface AccruePortfolioTickInput {
  readonly elapsedMilliseconds: number;
  readonly borrowPositions: readonly BorrowAccrualPosition[];
  readonly fundingPositions: readonly FundingAccrualPosition[];
}

export interface AccruePortfolioTickResult {
  readonly portfolio: PortfolioState;
  readonly transactions: readonly PortfolioTransaction[];
}

const ZERO = FixedPointDecimal.fromStroops(0n);

export function createPortfolioState(
  cash: FixedPointDecimal,
  debt: FixedPointDecimal = ZERO
): PortfolioState {
  return {
    cash,
    debt,
    equity: FixedPointDecimal.fromStroops(cash.toStroops() - debt.toStroops()),
    accrualRemainders: {},
  };
}

export function applyPortfolioTransaction(
  portfolio: PortfolioState,
  transaction: PortfolioTransaction
): PortfolioState {
  const amount = transaction.amount.toStroops();

  if (transaction.type === "borrow-interest") {
    return {
      ...portfolio,
      debt: FixedPointDecimal.fromStroops(portfolio.debt.toStroops() + amount),
      equity: FixedPointDecimal.fromStroops(
        portfolio.equity.toStroops() - amount
      ),
    };
  }

  return {
    ...portfolio,
    cash: FixedPointDecimal.fromStroops(portfolio.cash.toStroops() + amount),
    equity: FixedPointDecimal.fromStroops(
      portfolio.equity.toStroops() + amount
    ),
  };
}

/**
 * `base × rate × elapsed / (STROOPS_PER_UNIT × period)` evaluated in stroops,
 * with the truncated fraction carried in `remainder` so that dust survives a
 * tick short enough to accrue less than one stroop.
 */
function accrue(
  base: bigint,
  rate: bigint,
  elapsedMilliseconds: bigint,
  periodMilliseconds: bigint,
  remainder: bigint
): { readonly amount: bigint; readonly remainder: bigint } {
  const numerator = base * rate * elapsedMilliseconds + remainder;
  const denominator = STROOPS_PER_UNIT * periodMilliseconds;

  return {
    amount: numerator / denominator,
    remainder: numerator % denominator,
  };
}

function assertDistinctIds(
  positions: readonly { readonly id: string }[],
  field: string
): void {
  const seen = new Set<string>();

  for (const { id } of positions) {
    if (seen.has(id)) {
      throw new RangeError(`${field} contains a duplicate id: ${id}`);
    }
    seen.add(id);
  }
}

export function accruePortfolioTick(
  portfolio: PortfolioState,
  input: AccruePortfolioTickInput
): AccruePortfolioTickResult {
  if (
    !Number.isSafeInteger(input.elapsedMilliseconds) ||
    input.elapsedMilliseconds < 0
  ) {
    throw new RangeError(
      "elapsedMilliseconds must be a non-negative safe integer"
    );
  }

  assertDistinctIds(input.borrowPositions, "borrowPositions");
  assertDistinctIds(input.fundingPositions, "fundingPositions");

  const elapsed = BigInt(input.elapsedMilliseconds);
  const remainders: Record<string, bigint> = {};
  const transactions: PortfolioTransaction[] = [];
  let nextPortfolio = portfolio;

  for (const position of input.borrowPositions) {
    if (position.outstandingDebt.toStroops() < 0n) {
      throw new RangeError("outstandingDebt must be non-negative");
    }
    if (position.annualRate.toStroops() < 0n) {
      throw new RangeError("annualRate must be non-negative");
    }

    const key = `borrow:${position.id}`;
    const accrued = accrue(
      position.outstandingDebt.toStroops(),
      position.annualRate.toStroops(),
      elapsed,
      YEAR_MILLISECONDS,
      portfolio.accrualRemainders[key] ?? 0n
    );
    remainders[key] = accrued.remainder;

    if (accrued.amount !== 0n) {
      const transaction: PortfolioTransaction = {
        type: "borrow-interest",
        amount: FixedPointDecimal.fromStroops(accrued.amount),
      };
      transactions.push(transaction);
      nextPortfolio = applyPortfolioTransaction(nextPortfolio, transaction);
    }
  }

  for (const position of input.fundingPositions) {
    if (position.notional.toStroops() < 0n) {
      throw new RangeError("notional must be non-negative");
    }

    const key = `funding:${position.id}`;
    const accrued = accrue(
      position.notional.toStroops(),
      position.rate.ratePerSecond.toStroops(),
      elapsed,
      MILLISECONDS_PER_FUNDING_PERIOD,
      portfolio.accrualRemainders[key] ?? 0n
    );
    remainders[key] = accrued.remainder;

    if (accrued.amount !== 0n) {
      const transaction: PortfolioTransaction = {
        type: "funding-payment",
        amount: FixedPointDecimal.fromStroops(accrued.amount),
      };
      transactions.push(transaction);
      nextPortfolio = applyPortfolioTransaction(nextPortfolio, transaction);
    }
  }

  return {
    portfolio: { ...nextPortfolio, accrualRemainders: remainders },
    transactions,
  };
}

/**
 * Holds when `equity` still records `cash - debt`, which accrual can only
 * break by mutating the portfolio outside `applyPortfolioTransaction`.
 */
export function preservesAccountingIdentity(
  portfolio: PortfolioState
): boolean {
  return (
    portfolio.cash.toStroops() ===
    portfolio.debt.toStroops() + portfolio.equity.toStroops()
  );
}
