import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";

export interface HealthFactorMonitorConfig {
  readonly liquidationModel: LiquidationParameterModel;
  /**
   * Safety buffer above liquidation threshold where deleveraging begins.
   * Health Factor trigger = 1.0 + safetyBuffer.
   * Example: 0.20 means when HF < 1.20, deleveraging begins.
   */
  readonly safetyBuffer: Decimal;
  /**
   * Target health factor to restore to on deleverage breach.
   * Target HF must be strictly greater than (1.0 + safetyBuffer).
   * Example: 1.50
   */
  readonly targetHealthFactor: Decimal;
}

export interface PositionState {
  readonly collateralAmount: Decimal;
  readonly collateralPrice: Decimal;
  readonly debt: Decimal;
}

export interface DeleverageDecision {
  readonly shouldDeleverage: boolean;
  readonly currentHealthFactor: Decimal | undefined;
  readonly triggerHealthFactor: Decimal;
  readonly targetHealthFactor: Decimal;
  readonly requiredDebtRepayment: Decimal;
  readonly requiredCollateralToSell: Decimal;
}

export class HealthFactorMonitor {
  readonly liquidationModel: LiquidationParameterModel;
  readonly safetyBuffer: Decimal;
  readonly triggerHealthFactor: Decimal;
  readonly targetHealthFactor: Decimal;

  constructor(config: HealthFactorMonitorConfig) {
    if (config.safetyBuffer.isNegative()) {
      throw new RangeError(
        `Safety buffer cannot be negative, got ${config.safetyBuffer.toString()}`
      );
    }
    const triggerHf = Decimal.one().add(config.safetyBuffer);
    if (config.targetHealthFactor.lte(triggerHf)) {
      throw new RangeError(
        `Target health factor (${config.targetHealthFactor.toString()}) must be strictly greater than trigger health factor (${triggerHf.toString()})`
      );
    }

    this.liquidationModel = config.liquidationModel;
    this.safetyBuffer = config.safetyBuffer;
    this.triggerHealthFactor = triggerHf;
    this.targetHealthFactor = config.targetHealthFactor;
  }

  /**
   * Compute current position health factor:
   * HF = (collateralAmount * collateralPrice * liquidationThreshold) / debt
   */
  computeHealthFactor(position: PositionState): Decimal | undefined {
    if (position.debt.isZero()) {
      return undefined;
    }
    const collateralValue = position.collateralAmount.mul(
      position.collateralPrice
    );
    return this.liquidationModel.computeHealthFactor(
      collateralValue,
      position.debt
    );
  }

  /**
   * Evaluate position risk and size deleveraging orders to restore health factor to target.
   *
   * Derivation of required debt repayment (R):
   * Target HF = (Collateral' * Price * Threshold) / (Debt - R)
   * Where Collateral' = Collateral - (R / Price)
   * Collateral' * Price = Collateral * Price - R
   * Target HF * (Debt - R) = (Collateral * Price - R) * Threshold
   * Target HF * Debt - Target HF * R = CollateralValue * Threshold - R * Threshold
   * R * (Target HF - Threshold) = Target HF * Debt - CollateralValue * Threshold
   * R = (Target HF * Debt - CollateralValue * Threshold) / (Target HF - Threshold)
   */
  evaluate(position: PositionState): DeleverageDecision {
    const currentHf = this.computeHealthFactor(position);

    if (
      !currentHf ||
      currentHf.gte(this.triggerHealthFactor) ||
      position.debt.isZero()
    ) {
      return {
        shouldDeleverage: false,
        currentHealthFactor: currentHf,
        triggerHealthFactor: this.triggerHealthFactor,
        targetHealthFactor: this.targetHealthFactor,
        requiredDebtRepayment: Decimal.zero(),
        requiredCollateralToSell: Decimal.zero(),
      };
    }

    const collateralValue = position.collateralAmount.mul(
      position.collateralPrice
    );
    const threshold = this.liquidationModel.liquidationThreshold;

    const numerator = this.targetHealthFactor
      .mul(position.debt)
      .sub(collateralValue.mul(threshold));
    const denominator = this.targetHealthFactor.sub(threshold);

    if (denominator.lte(Decimal.zero()) || numerator.lte(Decimal.zero())) {
      return {
        shouldDeleverage: false,
        currentHealthFactor: currentHf,
        triggerHealthFactor: this.triggerHealthFactor,
        targetHealthFactor: this.targetHealthFactor,
        requiredDebtRepayment: Decimal.zero(),
        requiredCollateralToSell: Decimal.zero(),
      };
    }

    let requiredDebtRepay = numerator.div(denominator);
    if (requiredDebtRepay.gt(position.debt)) {
      requiredDebtRepay = position.debt;
    }

    let requiredCollateralToSell = requiredDebtRepay.div(
      position.collateralPrice
    );
    if (requiredCollateralToSell.gt(position.collateralAmount)) {
      requiredCollateralToSell = position.collateralAmount;
    }

    return {
      shouldDeleverage: true,
      currentHealthFactor: currentHf,
      triggerHealthFactor: this.triggerHealthFactor,
      targetHealthFactor: this.targetHealthFactor,
      requiredDebtRepayment: requiredDebtRepay,
      requiredCollateralToSell,
    };
  }

  /**
   * Execute auto-deleverage check before engine liquidation check.
   * If breach detected, returns updated position state after unwinding and confirms position is safe from liquidation.
   */
  processTick(position: PositionState): {
    updatedPosition: PositionState;
    decision: DeleverageDecision;
    isLiquidatedByEngine: boolean;
  } {
    const decision = this.evaluate(position);

    let updatedPosition = position;
    if (decision.shouldDeleverage) {
      updatedPosition = {
        collateralAmount: position.collateralAmount.sub(
          decision.requiredCollateralToSell
        ),
        collateralPrice: position.collateralPrice,
        debt: position.debt.sub(decision.requiredDebtRepayment),
      };
    }

    const isLiquidatedByEngine = this.liquidationModel.isLiquidatable(
      updatedPosition.collateralAmount.mul(updatedPosition.collateralPrice),
      updatedPosition.debt
    );

    return {
      updatedPosition,
      decision,
      isLiquidatedByEngine,
    };
  }
}
