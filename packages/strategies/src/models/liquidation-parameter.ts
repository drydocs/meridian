import { Decimal } from "../decimal";

/**
 * Per-asset borrowing parameters for a collateral asset.
 *
 * All three parameters are fractions of collateral value rather than amounts, so
 * an 85% liquidation threshold is `Decimal.fromString("0.85")`.
 */
export class LiquidationParameterModel {
  /** Maximum loan-to-value the protocol allows against this collateral. */
  public readonly maxLoanToValue: Decimal;
  /** Discount applied to collateral value when deriving health. */
  public readonly liquidationThreshold: Decimal;
  /** Penalty applied to a liquidated position, carried here for consumers. */
  public readonly liquidationPenalty: Decimal;

  constructor(
    maxLoanToValue: Decimal,
    liquidationThreshold: Decimal,
    liquidationPenalty: Decimal
  ) {
    if (
      maxLoanToValue.isNegative() ||
      liquidationThreshold.isNegative() ||
      liquidationPenalty.isNegative()
    ) {
      throw new RangeError("Liquidation parameters cannot be negative");
    }
    if (liquidationThreshold.lt(maxLoanToValue)) {
      throw new RangeError(
        "Liquidation threshold cannot be below max loan-to-value"
      );
    }
    if (liquidationThreshold.isZero()) {
      throw new RangeError("Liquidation threshold must be greater than zero");
    }

    this.maxLoanToValue = maxLoanToValue;
    this.liquidationThreshold = liquidationThreshold;
    this.liquidationPenalty = liquidationPenalty;
  }

  /**
   * Health factor, `collateralValue * liquidationThreshold / debt`, where the
   * position is at its liquidation boundary when the result is 1.0.
   *
   * Returns `undefined` when there is no debt, since the position can never be
   * liquidated and no finite factor describes it.
   */
  public computeHealthFactor(
    collateralValue: Decimal,
    debt: Decimal
  ): Decimal | undefined {
    LiquidationParameterModel.assertNonNegative(
      collateralValue,
      "Collateral value"
    );
    LiquidationParameterModel.assertNonNegative(debt, "Debt");

    if (debt.isZero()) {
      return undefined;
    }
    return collateralValue.mul(this.liquidationThreshold).div(debt);
  }

  /**
   * Price per unit of collateral at which the health factor reaches 1.0, so any
   * lower price leaves the position liquidatable.
   *
   * Returns `undefined` when no finite price exists. That covers a position with
   * no debt, which is never liquidatable, and a position with no collateral,
   * which is liquidatable at every price.
   */
  public computeLiquidationPrice(
    collateralAmount: Decimal,
    debt: Decimal
  ): Decimal | undefined {
    LiquidationParameterModel.assertNonNegative(
      collateralAmount,
      "Collateral amount"
    );
    LiquidationParameterModel.assertNonNegative(debt, "Debt");

    if (collateralAmount.isZero() || debt.isZero()) {
      return undefined;
    }

    const discountedCollateral = collateralAmount.mul(
      this.liquidationThreshold
    );
    if (discountedCollateral.isZero()) {
      return undefined;
    }
    return debt.div(discountedCollateral);
  }

  /**
   * A position is liquidatable when its health factor is strictly below 1.0, so
   * sitting exactly at 1.0 is safe. A position carrying no debt is never
   * liquidatable.
   */
  public isLiquidatable(collateralValue: Decimal, debt: Decimal): boolean {
    const healthFactor = this.computeHealthFactor(collateralValue, debt);
    return (
      healthFactor !== undefined &&
      healthFactor.lt(Decimal.one(healthFactor.scale))
    );
  }

  private static assertNonNegative(value: Decimal, name: string): void {
    if (value.isNegative()) {
      throw new RangeError(`${name} cannot be negative`);
    }
  }
}
