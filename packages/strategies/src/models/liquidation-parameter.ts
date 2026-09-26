export const FIXED_POINT_SCALE = 10n ** 18n;

export class LiquidationParameterModel {
  /** Max loan-to-value (scaled by 1e18) */
  public readonly maxLoanToValue: bigint;
  /** Liquidation threshold (scaled by 1e18) */
  public readonly liquidationThreshold: bigint;
  /** Liquidation penalty (scaled by 1e18) */
  public readonly liquidationPenalty: bigint;

  constructor(
    maxLoanToValue: bigint,
    liquidationThreshold: bigint,
    liquidationPenalty: bigint
  ) {
    if (liquidationThreshold < maxLoanToValue) {
      throw new Error("Liquidation threshold cannot be below max loan-to-value");
    }
    this.maxLoanToValue = maxLoanToValue;
    this.liquidationThreshold = liquidationThreshold;
    this.liquidationPenalty = liquidationPenalty;
  }

  /**
   * Compute health factor from collateral value and debt.
   * Health Factor = (Collateral Value * Liquidation Threshold) / Debt
   * Values are expected to be in the same fixed-point scale.
   */
  computeHealthFactor(collateralValue: bigint, debt: bigint): bigint {
    if (debt === 0n) {
      return -1n; // Represents infinity or max health when there's no debt
    }
    // Collateral value and threshold are both 1e18. 
    // To preserve 1e18 scale in the result:
    // (collateralValue * liquidationThreshold) / 1e18 = discountedCollateral
    // Health Factor = (discountedCollateral * 1e18) / debt
    const discountedCollateral = (collateralValue * this.liquidationThreshold) / FIXED_POINT_SCALE;
    return (discountedCollateral * FIXED_POINT_SCALE) / debt;
  }

  /**
   * Compute the liquidation price for a given collateral amount and debt position.
   * Liquidation Price = Debt / (Collateral Amount * Liquidation Threshold)
   * This is the price of the collateral asset at which the health factor becomes exactly 1.0.
   */
  computeLiquidationPrice(collateralAmount: bigint, debt: bigint): bigint {
    if (collateralAmount === 0n) {
      return 0n;
    }
    const discountedCollateral = (collateralAmount * this.liquidationThreshold) / FIXED_POINT_SCALE;
    if (discountedCollateral === 0n) return 0n;
    return (debt * FIXED_POINT_SCALE) / discountedCollateral;
  }

  /**
   * Boundary behavior at exactly the threshold:
   * A health factor of exactly 1.0 (FIXED_POINT_SCALE) means the position is at the threshold.
   * According to standard lending protocols, a position is typically liquidatable if Health Factor < 1.0.
   * Therefore, at exactly the threshold, it is NOT liquidatable (or depending on protocol, it may be).
   * We define the boundary such that exact threshold is considered SAFE.
   */
  isLiquidatable(collateralValue: bigint, debt: bigint): boolean {
    if (debt === 0n) return false;
    const hf = this.computeHealthFactor(collateralValue, debt);
    // Boundary behavior: strictly less than 1.0 is liquidatable.
    return hf < FIXED_POINT_SCALE;
  }
}
