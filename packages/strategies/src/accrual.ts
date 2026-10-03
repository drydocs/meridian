import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";

export const YEAR_MILLISECONDS = 365n * 24n * 60n * 60n * 1000n;

export interface PortfolioState {
  readonly cash: FixedPointDecimal;
  readonly debt: FixedPointDecimal;
  readonly equity: FixedPointDecimal;
  readonly accrualRemainders: Readonly<Record<string, bigint>>;
}

export type PortfolioTransaction =
  | { readonly type: "borrow-interest"; readonly amount: FixedPointDecimal }
  | { readonly type: "funding-payment"; readonly amount: FixedPointDecimal };

export interface BorrowAccrualPosition {
  readonly id: string;
  readonly outstandingDebt: FixedPointDecimal;
  readonly annualRate: FixedPointDecimal;
}

export interface FundingAccrualPosition {
  readonly id: string;
  readonly notional: FixedPointDecimal;
  readonly annualRate: FixedPointDecimal;
  readonly side: "long" | "short";
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
    cash: FixedPointDecimal.fromStroops(portfolio.cash.toStroops() - amount),
    equity: FixedPointDecimal.fromStroops(
      portfolio.equity.toStroops() - amount
    ),
  };
}

function accrueAmount(
  base: FixedPointDecimal,
  annualRate: FixedPointDecimal,
  elapsedMilliseconds: bigint,
  remainder: bigint
): { amount: FixedPointDecimal; remainder: bigint } {
  const numerator =
    base.toStroops() * annualRate.toStroops() * elapsedMilliseconds + remainder;
  const denominator = STROOPS_PER_UNIT * YEAR_MILLISECONDS;

  return {
    amount: FixedPointDecimal.fromStroops(numerator / denominator),
    remainder: numerator % denominator,
  };
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

  const elapsed = BigInt(input.elapsedMilliseconds);
  const remainders = { ...portfolio.accrualRemainders };
  const transactions: PortfolioTransaction[] = [];
  let nextPortfolio = portfolio;

  for (const position of input.borrowPositions) {
    if (position.outstandingDebt.toStroops() < 0n) {
      throw new RangeError("outstandingDebt must be non-negative");
    }
    const key = `borrow:${position.id}`;
    const accrued = accrueAmount(
      position.outstandingDebt,
      position.annualRate,
      elapsed,
      remainders[key] ?? 0n
    );
    remainders[key] = accrued.remainder;
    if (accrued.amount.toStroops() !== 0n) {
      const transaction: PortfolioTransaction = {
        type: "borrow-interest",
        amount: accrued.amount,
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
    const accrued = accrueAmount(
      position.notional,
      position.annualRate,
      elapsed,
      remainders[key] ?? 0n
    );
    const signedAmount =
      position.side === "long"
        ? accrued.amount
        : FixedPointDecimal.fromStroops(-accrued.amount.toStroops());
    remainders[key] = accrued.remainder;
    if (signedAmount.toStroops() !== 0n) {
      const transaction: PortfolioTransaction = {
        type: "funding-payment",
        amount: signedAmount,
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

export function preservesAccountingIdentity(
  portfolio: PortfolioState
): boolean {
  return (
    portfolio.cash.toStroops() ===
    portfolio.debt.toStroops() + portfolio.equity.toStroops()
  );
}
