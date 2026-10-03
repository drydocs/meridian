import { Decimal } from "./decimal";

export interface LiquidationParameterConfig {
  readonly maxLoanToValue: Decimal;
  readonly liquidationThreshold: Decimal;
  readonly liquidationPenalty: Decimal;
}

export class LiquidationParameterModel {
  readonly maxLoanToValue: Decimal;
  readonly liquidationThreshold: Decimal;
  readonly liquidationPenalty: Decimal;

  constructor(config: LiquidationParameterConfig) {
    if (config.liquidationThreshold.lt(config.maxLoanToValue)) {
      throw new RangeError(
        `Liquidation threshold (${config.liquidationThreshold.toString()}) cannot be below max loan-to-value (${config.maxLoanToValue.toString()})`
      );
    }
    if (
      config.maxLoanToValue.isNegative() ||
      config.liquidationThreshold.isNegative() ||
      config.liquidationPenalty.isNegative()
    ) {
      throw new RangeError("Liquidation parameters cannot be negative");
    }
    this.maxLoanToValue = config.maxLoanToValue;
    this.liquidationThreshold = config.liquidationThreshold;
    this.liquidationPenalty = config.liquidationPenalty;
  }

  /**
   * Health factor = (collateralValue * liquidationThreshold) / debt
   * Returns undefined if debt is zero (infinite health).
   */
  computeHealthFactor(
    collateralValue: Decimal,
    debt: Decimal
  ): Decimal | undefined {
    if (debt.isZero()) {
      return undefined;
    }
    const adjustedCollateral = collateralValue.mul(this.liquidationThreshold);
    return adjustedCollateral.div(debt);
  }

  /**
   * Liquidation price = debt / (collateralAmount * liquidationThreshold)
   * Price below which position becomes liquidatable (Health Factor < 1.0).
   */
  computeLiquidationPrice(collateralAmount: Decimal, debt: Decimal): Decimal {
    if (collateralAmount.isZero() || this.liquidationThreshold.isZero()) {
      return Decimal.zero(debt.scale);
    }
    const adjustedCollateral = collateralAmount.mul(this.liquidationThreshold);
    if (adjustedCollateral.isZero()) {
      return Decimal.zero(debt.scale);
    }
    return debt.div(adjustedCollateral);
  }

  /**
   * Position is liquidatable if health factor is strictly less than 1.0.
   * Boundary behavior: Exactly at 1.0 is considered safe.
   */
  isLiquidatable(collateralValue: Decimal, debt: Decimal): boolean {
    if (debt.isZero()) {
      return false;
    }
    const hf = this.computeHealthFactor(collateralValue, debt);
    if (!hf) {
      return false;
    }
    return hf.lt(Decimal.one(hf.scale));
  }
}
