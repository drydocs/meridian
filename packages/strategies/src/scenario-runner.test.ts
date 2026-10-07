import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";
import { SelfRepayingLoanRunner, MarketTick } from "./scenario-runner";

describe("Self-Repaying Loan Scenario Backtests", () => {
  const liquidationModel = new LiquidationParameterModel({
    maxLoanToValue: Decimal.fromString("0.80"), // 80%
    liquidationThreshold: Decimal.fromString("0.85"), // 85%
    liquidationPenalty: Decimal.fromString("0.05"), // 5%
  });

  const baseConfig = {
    collateralAsset: "USDC",
    borrowAsset: "USDG",
    initialCollateralAmount: Decimal.fromString("1000.00"), // $1000 collateral
    initialBorrowAmount: Decimal.fromString("500.00"), // $500 debt (50% initial LTV)
    liquidationModel,
    deleverageThresholdHf: Decimal.fromString("1.20"),
    deleverageTargetHf: Decimal.fromString("1.40"),
  };

  it("Scenario 1: Steady positive-yield path that fully repays loan within horizon", () => {
    const runner = new SelfRepayingLoanRunner(baseConfig);

    // 10 periods with positive yield (10% per period = $50 yield per tick), 0% borrow interest, price stable at $1.00
    const ticks: MarketTick[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 1000 + i * 3600,
      collateralPrice: Decimal.fromString("1.00"),
      yieldRate: Decimal.fromString("0.10"), // 10% per tick on $500 initial = $50
      borrowInterestRate: Decimal.zero(),
    }));

    const report = runner.runScenario("steady-positive-yield", ticks);

    expect(report.wasLiquidated).toBe(false);
    expect(report.isFullyRepaid).toBe(true);
    expect(report.finalDebt.isZero()).toBe(true);
    expect(report.finalCollateral.toString()).toBe("1000.0000000"); // Zero collateral lost
    expect(report.totalYieldRepaid.toString()).toBe("500.0000000");
    expect(report.totalDeleveragedCollateral.isZero()).toBe(true);
    expect(report.snapshots).toHaveLength(10);
  });

  it("Scenario 2: Yield-collapse path that stalls repayment while remaining solvent", () => {
    const runner = new SelfRepayingLoanRunner(baseConfig);

    // 10 periods: initial yield 5% for first 2 ticks, then collapses to 0.0% for remaining 8 ticks
    // Collateral price remains constant at $1.00, borrow interest 0.1% per tick
    const ticks: MarketTick[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 1000 + i * 3600,
      collateralPrice: Decimal.fromString("1.00"),
      yieldRate: i < 2 ? Decimal.fromString("0.05") : Decimal.zero(), // 25 + 25 = 50 repaid, then stalls
      borrowInterestRate: Decimal.fromString("0.001"), // 0.1% interest
    }));

    const report = runner.runScenario("yield-collapse", ticks);

    expect(report.wasLiquidated).toBe(false);
    expect(report.isFullyRepaid).toBe(false);
    expect(report.finalDebt.gt(Decimal.zero())).toBe(true);
    // Solvency maintained
    expect(report.finalCollateral.toString()).toBe("1000.0000000");
    expect(report.totalYieldEarned.toString()).toBe("50.0000000");
    expect(report.totalYieldRepaid.toString()).toBe("50.0000000");
  });

  it("Scenario 3: Collateral-price-drop drawdown path that exercises auto-deleverage without forced liquidation", () => {
    const runner = new SelfRepayingLoanRunner(baseConfig);

    // Collateral starts at $1.00, drops to $0.65 (would cause HF = 650 * 0.85 / 500 = 1.105 < 1.20 threshold)
    // Auto-deleverage triggers, unwinds collateral, reduces debt, and avoids liquidation (HF stays > 1.0)
    const ticks: MarketTick[] = [
      {
        timestamp: 1000,
        collateralPrice: Decimal.fromString("1.00"),
        yieldRate: Decimal.fromString("0.01"),
        borrowInterestRate: Decimal.zero(),
      },
      {
        timestamp: 2000,
        collateralPrice: Decimal.fromString("0.65"), // sharp price drop
        yieldRate: Decimal.fromString("0.01"),
        borrowInterestRate: Decimal.zero(),
      },
      {
        timestamp: 3000,
        collateralPrice: Decimal.fromString("0.65"), // price stays down
        yieldRate: Decimal.fromString("0.01"),
        borrowInterestRate: Decimal.zero(),
      },
    ];

    const report = runner.runScenario("collateral-drawdown-deleverage", ticks);

    expect(report.wasLiquidated).toBe(false);
    expect(report.totalDeleveragedCollateral.gt(Decimal.zero())).toBe(true);
    expect(report.finalCollateral.lt(report.initialCollateral)).toBe(true);
    expect(report.finalDebt.lt(report.initialDebt)).toBe(true);

    // Assert every snapshot maintained safe health factor (HF >= 1.0)
    for (const snap of report.snapshots) {
      if (snap.healthFactor) {
        expect(snap.healthFactor.gte(Decimal.fromString("1.00"))).toBe(true);
      }
      expect(snap.isLiquidated).toBe(false);
    }
  });
});
