import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";

export type DeleverageOrderingPolicy =
  "highest-risk-first" | "lowest-liquidity-penalty-first" | "pro-rata";

export interface CollateralPosition {
  readonly asset: string;
  readonly amount: Decimal;
  readonly price: Decimal;
  readonly liquidationModel: LiquidationParameterModel;
}

export interface MultiCollateralBasketConfig {
  readonly positions: CollateralPosition[];
  readonly deleveragePolicy?: DeleverageOrderingPolicy;
}

export interface DeleverageOrder {
  readonly asset: string;
  readonly amountToUnwind: Decimal;
  readonly debtRepaidValue: Decimal;
}

export class MultiCollateralBasket {
  readonly positions: CollateralPosition[];
  readonly deleveragePolicy: DeleverageOrderingPolicy;

  constructor(config: MultiCollateralBasketConfig) {
    if (config.positions.length === 0) {
      throw new RangeError(
        "MultiCollateralBasket requires at least one collateral position"
      );
    }
    this.positions = [...config.positions];
    this.deleveragePolicy = config.deleveragePolicy ?? "highest-risk-first";
  }

  /**
   * Total collateral value in quote currency = sum(amount_i * price_i)
   */
  computeTotalCollateralValue(): Decimal {
    let total = Decimal.zero();
    for (const pos of this.positions) {
      const posVal = pos.amount.mul(pos.price);
      total = total.add(posVal);
    }
    return total;
  }

  /**
   * Blended liquidation threshold = sum(val_i * threshold_i) / sum(val_i)
   */
  computeBlendedLiquidationThreshold(): Decimal {
    const totalVal = this.computeTotalCollateralValue();
    if (totalVal.isZero()) {
      return Decimal.zero();
    }
    let weightedThresholdSum = Decimal.zero();
    for (const pos of this.positions) {
      const posVal = pos.amount.mul(pos.price);
      const weighted = posVal.mul(pos.liquidationModel.liquidationThreshold);
      weightedThresholdSum = weightedThresholdSum.add(weighted);
    }
    return weightedThresholdSum.div(totalVal);
  }

  /**
   * Blended max loan-to-value = sum(val_i * maxLtv_i) / sum(val_i)
   */
  computeBlendedMaxLoanToValue(): Decimal {
    const totalVal = this.computeTotalCollateralValue();
    if (totalVal.isZero()) {
      return Decimal.zero();
    }
    let weightedLtvSum = Decimal.zero();
    for (const pos of this.positions) {
      const posVal = pos.amount.mul(pos.price);
      const weighted = posVal.mul(pos.liquidationModel.maxLoanToValue);
      weightedLtvSum = weightedLtvSum.add(weighted);
    }
    return weightedLtvSum.div(totalVal);
  }

  /**
   * Blended health factor across multi-collateral basket =
   * sum(amount_i * price_i * threshold_i) / debt
   * Returns undefined if debt is zero.
   */
  computeHealthFactor(debt: Decimal): Decimal | undefined {
    if (debt.isZero()) {
      return undefined;
    }
    let totalDiscountedCollateral = Decimal.zero();
    for (const pos of this.positions) {
      const posVal = pos.amount.mul(pos.price);
      const discounted = posVal.mul(pos.liquidationModel.liquidationThreshold);
      totalDiscountedCollateral = totalDiscountedCollateral.add(discounted);
    }
    return totalDiscountedCollateral.div(debt);
  }

  /**
   * Determine unwinding order across collateral assets according to the policy:
   * - "highest-risk-first": Sort by lowest liquidation threshold first (i.e. highest risk / least safe collateral)
   * - "lowest-liquidity-penalty-first": Sort by lowest liquidation penalty first (preserves value)
   * - "pro-rata": Distribute debt repayment proportionally across positions
   */
  computeDeleveragePlan(requiredDebtRepayment: Decimal): DeleverageOrder[] {
    if (requiredDebtRepayment.lte(Decimal.zero())) {
      return [];
    }

    const orders: DeleverageOrder[] = [];
    let remainingDebtToRepay = requiredDebtRepayment;

    if (this.deleveragePolicy === "pro-rata") {
      const totalCollateralValue = this.computeTotalCollateralValue();
      if (totalCollateralValue.isZero()) {
        return [];
      }

      for (const pos of this.positions) {
        if (remainingDebtToRepay.isZero()) break;
        const posValue = pos.amount.mul(pos.price);
        if (posValue.isZero() || pos.price.isZero()) continue;

        // Share of total value
        const share = posValue.div(totalCollateralValue);
        let debtToCover = requiredDebtRepayment.mul(share);
        if (debtToCover.gt(remainingDebtToRepay)) {
          debtToCover = remainingDebtToRepay;
        }
        if (debtToCover.gt(posValue)) {
          debtToCover = posValue;
        }

        const amountToUnwind = debtToCover.div(pos.price);
        orders.push({
          asset: pos.asset,
          amountToUnwind,
          debtRepaidValue: debtToCover,
        });
      }
      return orders;
    }

    // Sort positions copy based on policy
    const sortedPositions = [...this.positions].sort((a, b) => {
      if (this.deleveragePolicy === "highest-risk-first") {
        // Lower threshold = riskier collateral, unwind first
        if (
          a.liquidationModel.liquidationThreshold.lt(
            b.liquidationModel.liquidationThreshold
          )
        )
          return -1;
        if (
          a.liquidationModel.liquidationThreshold.gt(
            b.liquidationModel.liquidationThreshold
          )
        )
          return 1;
        return a.asset.localeCompare(b.asset);
      } else {
        // "lowest-liquidity-penalty-first"
        if (
          a.liquidationModel.liquidationPenalty.lt(
            b.liquidationModel.liquidationPenalty
          )
        )
          return -1;
        if (
          a.liquidationModel.liquidationPenalty.gt(
            b.liquidationModel.liquidationPenalty
          )
        )
          return 1;
        return a.asset.localeCompare(b.asset);
      }
    });

    for (const pos of sortedPositions) {
      if (remainingDebtToRepay.lte(Decimal.zero())) break;
      if (pos.price.isZero() || pos.amount.isZero()) continue;

      const posValue = pos.amount.mul(pos.price);
      const debtCovered = posValue.gte(remainingDebtToRepay)
        ? remainingDebtToRepay
        : posValue;
      const amountToUnwind = debtCovered.div(pos.price);

      orders.push({
        asset: pos.asset,
        amountToUnwind,
        debtRepaidValue: debtCovered,
      });

      remainingDebtToRepay = remainingDebtToRepay.sub(debtCovered);
    }

    return orders;
  }
}
