import { describe, expect, it } from "vitest";

import type { RawSelfRepayingLoanConfig } from "./config";
import { Decimal } from "./decimal";
import { SelfRepayingLoanStrategy } from "./self-repaying-loan";

/** Deterministic LCG, so every run of the suite exercises the same paths. */
class DeterministicPrng {
  private state: number;

  constructor(seed: number = 42) {
    this.state = seed % 2147483647;
    if (this.state <= 0) {
      this.state += 2147483646;
    }
  }

  next(): number {
    this.state = (this.state * 16807) % 2147483647;
    return (this.state - 1) / 2147483646;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextDecimal(min: number, max: number, decimals: number = 2): Decimal {
    const rawValue = min + this.next() * (max - min);
    return Decimal.fromString(rawValue.toFixed(decimals));
  }
}

const baseConfig: RawSelfRepayingLoanConfig = {
  collateralAsset: "XLM",
  borrowAsset: "USDC",
  yieldSource: "blend-pool",
  openingLoanToValue: Decimal.fromString("0.50"),
  deleverageBuffer: Decimal.fromString("0.05"),
  deleverageTargetLtv: Decimal.fromString("0.55"),
  liquidationThreshold: Decimal.fromString("0.75"),
  liquidationPenalty: Decimal.fromString("0.08"),
  borrowRate: {
    mode: "fixed",
    fixedRate: Decimal.fromString("0.05"),
  },
};

describe("Accounting Invariant Property Tests", () => {
  it("keeps the debt accounting identity across randomised amortisation paths", () => {
    const strategy = new SelfRepayingLoanStrategy(baseConfig);
    const numRuns = 50;

    for (let run = 0; run < numRuns; run++) {
      const rng = new DeterministicPrng(1000 + run);

      const { nextState: openState } = strategy.open({
        collateralAmount: rng.nextDecimal(1000, 50000),
        collateralPrice: rng.nextDecimal(0.1, 2.0),
      });

      const initialDebt = openState.debtAmount;
      let state = openState;
      // Ledger derived here from the step inputs, so the assertions below do
      // not simply restate the totals the implementation reports back.
      let referenceDebt = initialDebt;
      let referenceInterest = Decimal.zero();
      let referenceAmortized = Decimal.zero();

      const numSteps = rng.nextInt(5, 20);
      for (let step = 0; step < numSteps; step++) {
        if (state.debtAmount.isZero()) {
          break;
        }

        const yieldAccrued = rng.nextDecimal(10, 500);
        const interestRate = rng.nextDecimal(0.001, 0.02, 4);
        const collateralPrice = rng.nextDecimal(0.1, 2.0);

        const interest = referenceDebt.mul(interestRate);
        const debtWithInterest = referenceDebt.add(interest);
        const repay = yieldAccrued.gte(debtWithInterest)
          ? debtWithInterest
          : yieldAccrued;
        referenceDebt = debtWithInterest.sub(repay);
        referenceInterest = referenceInterest.add(interest);
        referenceAmortized = referenceAmortized.add(repay);

        state = strategy.amortize({
          state,
          yieldAccrued,
          borrowInterestRatePeriod: interestRate,
          collateralPrice,
        }).nextState;

        expect(state.debtAmount.toString()).toBe(referenceDebt.toString());
        expect(state.totalInterestAccrued.toString()).toBe(
          referenceInterest.toString()
        );
        expect(state.totalYieldAmortized.toString()).toBe(
          referenceAmortized.toString()
        );

        // InitialDebt + TotalInterest = RemainingDebt + TotalYieldAmortized
        expect(initialDebt.add(referenceInterest).toString()).toBe(
          referenceDebt.add(referenceAmortized).toString()
        );
        expect(state.debtAmount.isNegative()).toBe(false);
        expect(state.totalYieldAmortized.gte(Decimal.zero())).toBe(true);
        expect(state.totalInterestAccrued.gte(Decimal.zero())).toBe(true);
      }

      const repayableFunds = state.yieldDeployedPrincipal;
      if (repayableFunds.gte(state.debtAmount)) {
        const { nextState: closedState } = strategy.close({ state });

        expect(closedState.isClosed).toBe(true);
        expect(closedState.isOpen).toBe(false);
        expect(closedState.debtAmount.isZero()).toBe(true);
        expect(closedState.collateralAmount.isZero()).toBe(true);
      } else {
        expect(() => strategy.close({ state })).toThrowError(
          /exceeds repayable funds/
        );
      }
    }
  });

  it("replays an identical trace for a repeated seed and a different one across seeds", () => {
    const runSimulation = (seed: number) => {
      const strategy = new SelfRepayingLoanStrategy(baseConfig);
      const rng = new DeterministicPrng(seed);

      const { nextState: openState } = strategy.open({
        collateralAmount: rng.nextDecimal(5000, 20000),
        collateralPrice: rng.nextDecimal(0.15, 0.35),
      });

      let state = openState;
      const history: Array<{
        debt: string;
        amortized: string;
        interest: string;
      }> = [];

      for (let i = 0; i < 15; i++) {
        const yieldAccrued = rng.nextDecimal(20, 300);
        const interestRate = rng.nextDecimal(0.005, 0.015, 4);

        state = strategy.amortize({
          state,
          yieldAccrued,
          borrowInterestRatePeriod: interestRate,
        }).nextState;

        history.push({
          debt: state.debtAmount.toString(),
          amortized: state.totalYieldAmortized.toString(),
          interest: state.totalInterestAccrued.toString(),
        });
      }

      return {
        finalDebt: state.debtAmount.toString(),
        finalAmortized: state.totalYieldAmortized.toString(),
        history,
      };
    };

    for (let seed = 1; seed <= 20; seed++) {
      expect(runSimulation(seed)).toEqual(runSimulation(seed));
    }

    // Without this the comparisons above would also pass if the strategy
    // ignored its inputs entirely.
    expect(runSimulation(1)).not.toEqual(runSimulation(2));
  });
});
