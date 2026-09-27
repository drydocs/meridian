import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import type { RawSelfRepayingLoanConfig } from "./config";
import {
  SelfRepayingLoanStrategy,
  type SelfRepayingLoanState,
} from "./self-repaying-loan";

// Deterministic pseudo-random number generator (LCG)
class DeterministicPRNG {
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
    const rawVal = min + this.next() * (max - min);
    return Decimal.fromString(rawVal.toFixed(decimals));
  }
}

describe("Accounting Invariant Property Tests", () => {
  const baseConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "XLM",
    borrowAsset: "USDC",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.from("0.50"),
    deleverageBuffer: Decimal.from("0.05"),
    deleverageTargetLtv: Decimal.from("0.55"),
    liquidationThreshold: Decimal.from("0.75"),
    liquidationPenalty: Decimal.from("0.08"),
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.from("0.05"),
    },
  };

  it("maintains fundamental debt accounting invariant: InitialDebt + TotalInterest = RemainingDebt + TotalYieldAmortized", () => {
    const strategy = new SelfRepayingLoanStrategy(baseConfig);
    const numRuns = 50;

    for (let run = 0; run < numRuns; run++) {
      const rng = new DeterministicPRNG(1000 + run);

      const collateralAmt = rng.nextDecimal(1000, 50000);
      const collateralPrice = rng.nextDecimal(0.1, 2.0);

      const openRes = strategy.open({
        collateralAmount: collateralAmt,
        collateralPrice,
      });

      const initialDebt = openRes.nextState.debtAmount;
      let currentState: SelfRepayingLoanState = openRes.nextState;

      const numSteps = rng.nextInt(5, 20);
      for (let step = 0; step < numSteps; step++) {
        if (currentState.debtAmount.isZero()) {
          break;
        }

        const yieldAmt = rng.nextDecimal(10, 500);
        const interestRate = rng.nextDecimal(0.001, 0.02, 4);
        const price = rng.nextDecimal(0.1, 2.0);

        const amortizeRes = strategy.amortize({
          state: currentState,
          yieldAccrued: yieldAmt,
          borrowInterestRatePeriod: interestRate,
          collateralPrice: price,
        });

        currentState = amortizeRes.nextState;

        // Invariant: InitialDebt + TotalInterestAccrued == DebtAmount + TotalYieldAmortized
        const totalLiabilities = initialDebt.add(
          currentState.totalInterestAccrued
        );
        const totalSatisfied = currentState.debtAmount.add(
          currentState.totalYieldAmortized
        );

        expect(totalLiabilities.raw).toBe(totalSatisfied.raw);
        expect(currentState.debtAmount.gte(Decimal.zero())).toBe(true);
        expect(currentState.totalYieldAmortized.gte(Decimal.zero())).toBe(true);
        expect(currentState.totalInterestAccrued.gte(Decimal.zero())).toBe(true);
      }

      // Close the loan and assert final invariants
      const closeRes = strategy.close({
        state: currentState,
      });

      expect(closeRes.nextState.isClosed).toBe(true);
      expect(closeRes.nextState.isOpen).toBe(false);
      expect(closeRes.nextState.debtAmount.isZero()).toBe(true);
      expect(closeRes.nextState.collateralAmount.isZero()).toBe(true);
    }
  });

  it("guarantees identical reports for two runs with the same seed and scenario parameters", () => {
    const strategy = new SelfRepayingLoanStrategy(baseConfig);
    const runSimulationWithSeed = (seed: number) => {
      const rng = new DeterministicPRNG(seed);
      const collateralAmt = rng.nextDecimal(5000, 20000);
      const collateralPrice = rng.nextDecimal(0.15, 0.35);

      const openRes = strategy.open({
        collateralAmount: collateralAmt,
        collateralPrice,
      });

      let state = openRes.nextState;
      const history: Array<{
        debt: string;
        amortized: string;
        interest: string;
      }> = [];

      for (let i = 0; i < 15; i++) {
        const yieldAmt = rng.nextDecimal(20, 300);
        const interestRate = rng.nextDecimal(0.005, 0.015, 4);
        const stepRes = strategy.amortize({
          state,
          yieldAccrued: yieldAmt,
          borrowInterestRatePeriod: interestRate,
        });
        state = stepRes.nextState;
        history.push({
          debt: state.debtAmount.toString(),
          amortized: state.totalYieldAmortized.toString(),
          interest: state.totalInterestAccrued.toString(),
        });
      }

      return {
        finalStateDebt: state.debtAmount.toString(),
        finalStateAmortized: state.totalYieldAmortized.toString(),
        history,
      };
    };

    for (let seed = 1; seed <= 20; seed++) {
      const runA = runSimulationWithSeed(seed);
      const runB = runSimulationWithSeed(seed);

      expect(runA).toEqual(runB);
    }
  });
});
