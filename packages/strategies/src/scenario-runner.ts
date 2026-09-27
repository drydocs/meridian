import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";

export interface SelfRepayingLoanConfig {
  readonly collateralAsset: string;
  readonly borrowAsset: string;
  readonly initialCollateralAmount: Decimal;
  readonly initialBorrowAmount: Decimal;
  readonly liquidationModel: LiquidationParameterModel;
  /**
   * Health factor threshold below which deleveraging is triggered.
   * Default: 1.20 (20% safety margin above liquidation threshold 1.0)
   */
  readonly deleverageThresholdHf?: Decimal;
  /**
   * Health factor target to recover to on deleveraging.
   * Default: 1.40
   */
  readonly deleverageTargetHf?: Decimal;
}

export interface MarketTick {
  readonly timestamp: number;
  readonly collateralPrice: Decimal;
  readonly yieldRate: Decimal; // Period yield rate (e.g. 0.01 = 1% per period)
  readonly borrowInterestRate: Decimal; // Period borrow interest rate (e.g. 0.002)
}

export interface TickSnapshot {
  readonly tick: number;
  readonly timestamp: number;
  readonly collateralAmount: Decimal;
  readonly collateralPrice: Decimal;
  readonly collateralValue: Decimal;
  readonly debt: Decimal;
  readonly healthFactor: Decimal | undefined;
  readonly accruedYield: Decimal;
  readonly yieldRepaidDebt: Decimal;
  readonly deleveragedCollateral: Decimal;
  readonly isLiquidated: boolean;
}

export interface BacktestReport {
  readonly scenarioName: string;
  readonly initialCollateral: Decimal;
  readonly initialDebt: Decimal;
  readonly finalCollateral: Decimal;
  readonly finalDebt: Decimal;
  readonly totalYieldEarned: Decimal;
  readonly totalYieldRepaid: Decimal;
  readonly totalDeleveragedCollateral: Decimal;
  readonly isFullyRepaid: boolean;
  readonly wasLiquidated: boolean;
  readonly snapshots: TickSnapshot[];
}

export class SelfRepayingLoanRunner {
  readonly config: SelfRepayingLoanConfig;
  readonly deleverageThresholdHf: Decimal;
  readonly deleverageTargetHf: Decimal;

  constructor(config: SelfRepayingLoanConfig) {
    this.config = config;
    this.deleverageThresholdHf =
      config.deleverageThresholdHf ?? Decimal.fromString("1.20");
    this.deleverageTargetHf =
      config.deleverageTargetHf ?? Decimal.fromString("1.40");
  }

  runScenario(scenarioName: string, ticks: MarketTick[]): BacktestReport {
    let collateralAmount = this.config.initialCollateralAmount;
    let debt = this.config.initialBorrowAmount;
    let totalYieldEarned = Decimal.zero();
    let totalYieldRepaid = Decimal.zero();
    let totalDeleveragedCollateral = Decimal.zero();
    let wasLiquidated = false;

    const snapshots: TickSnapshot[] = [];

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i]!;

      // 1. Accrue borrow interest
      if (!debt.isZero()) {
        const interest = debt.mul(tick.borrowInterestRate);
        debt = debt.add(interest);
      }

      // 2. Accrue yield on deployed borrowed funds / collateral
      // The borrowed funds (or collateral) generate yield in terms of debt currency
      const currentYield = this.config.initialBorrowAmount.mul(tick.yieldRate);
      totalYieldEarned = totalYieldEarned.add(currentYield);

      // 3. Amortize debt with accrued yield
      let yieldRepaidDebt = Decimal.zero();
      if (!debt.isZero() && currentYield.gt(Decimal.zero())) {
        if (currentYield.gte(debt)) {
          yieldRepaidDebt = debt;
          debt = Decimal.zero();
        } else {
          yieldRepaidDebt = currentYield;
          debt = debt.sub(currentYield);
        }
        totalYieldRepaid = totalYieldRepaid.add(yieldRepaidDebt);
      }

      // 4. Check Health Factor & Auto-Deleverage before engine liquidation check
      let currentHf = this.config.liquidationModel.computeHealthFactor(
        collateralAmount.mul(tick.collateralPrice),
        debt
      );
      let deleveragedCollateral = Decimal.zero();

      if (
        currentHf &&
        currentHf.lt(this.deleverageThresholdHf) &&
        !debt.isZero()
      ) {
        // Auto-deleverage: calculate required debt repayment to bring HF back to deleverageTargetHf
        // Target HF = (Collateral' * LiquidationThreshold) / Debt'
        // Where Collateral' = Collateral - (RepayAmount / Price)
        // Debt' = Debt - RepayAmount
        // Solving for RepayAmount:
        // TargetHf * (Debt - Repay) = (CollateralValue - Repay) * Threshold
        // TargetHf * Debt - TargetHf * Repay = CollateralValue * Threshold - Repay * Threshold
        // Repay * (TargetHf - Threshold) = TargetHf * Debt - CollateralValue * Threshold
        const threshold = this.config.liquidationModel.liquidationThreshold;
        const targetHf = this.deleverageTargetHf;

        const num = targetHf
          .mul(debt)
          .sub(collateralAmount.mul(tick.collateralPrice).mul(threshold));
        const den = targetHf.sub(threshold);

        if (den.gt(Decimal.zero()) && num.gt(Decimal.zero())) {
          let debtToRepay = num.div(den);
          if (debtToRepay.gt(debt)) debtToRepay = debt;

          const collToSell = debtToRepay.div(tick.collateralPrice);
          if (collToSell.lte(collateralAmount)) {
            collateralAmount = collateralAmount.sub(collToSell);
            debt = debt.sub(debtToRepay);
            deleveragedCollateral = collToSell;
            totalDeleveragedCollateral =
              totalDeleveragedCollateral.add(collToSell);
          }
        }
        // Recompute HF after deleveraging
        currentHf = this.config.liquidationModel.computeHealthFactor(
          collateralAmount.mul(tick.collateralPrice),
          debt
        );
      }

      // 5. Engine liquidation check
      const isLiquidated = this.config.liquidationModel.isLiquidatable(
        collateralAmount.mul(tick.collateralPrice),
        debt
      );
      if (isLiquidated) {
        wasLiquidated = true;
      }

      snapshots.push({
        tick: i,
        timestamp: tick.timestamp,
        collateralAmount,
        collateralPrice: tick.collateralPrice,
        collateralValue: collateralAmount.mul(tick.collateralPrice),
        debt,
        healthFactor: currentHf,
        accruedYield: currentYield,
        yieldRepaidDebt,
        deleveragedCollateral,
        isLiquidated,
      });

      if (wasLiquidated) {
        break;
      }
    }

    return {
      scenarioName,
      initialCollateral: this.config.initialCollateralAmount,
      initialDebt: this.config.initialBorrowAmount,
      finalCollateral: collateralAmount,
      finalDebt: debt,
      totalYieldEarned,
      totalYieldRepaid,
      totalDeleveragedCollateral,
      isFullyRepaid: debt.isZero(),
      wasLiquidated,
      snapshots,
    };
  }
}
