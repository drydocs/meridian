import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";

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

function positionValue(position: CollateralPosition): Decimal {
  return position.amount.mul(position.price);
}

function assertNonNegative(value: Decimal, name: string): void {
  if (value.isNegative()) {
    throw new RangeError(`${name} cannot be negative`);
  }
}

function lowest(...values: Decimal[]): Decimal {
  return values.reduce((low, value) => (value.lt(low) ? value : low));
}

/** Three-way comparison, so sorting does not depend on the host's locale data. */
function compare(first: Decimal, second: Decimal): number {
  if (first.lt(second)) return -1;
  if (first.gt(second)) return 1;
  return 0;
}

function compareAsset(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

function toOrder(
  position: CollateralPosition,
  debtRepaidValue: Decimal
): DeleverageOrder {
  return {
    asset: position.asset,
    amountToUnwind: debtRepaidValue.div(position.price),
    debtRepaidValue,
  };
}

/**
 * A set of collateral positions lent against as one basket.
 *
 * The blended figures weight each position by its value, so a $100 position
 * counts twice as much as a $50 one when the basket's threshold, loan-to-value
 * or health is derived.
 */
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

  /** Total collateral value, the sum of `amount * price` across the basket. */
  computeTotalCollateralValue(): Decimal {
    return this.positions.reduce(
      (total, position) => total.add(positionValue(position)),
      Decimal.zero()
    );
  }

  /**
   * Value-weighted liquidation threshold, `sum(value * threshold) / sum(value)`.
   *
   * A basket holding no value returns zero. Nothing can be borrowed or
   * maintained against it, and no other threshold describes that state.
   */
  computeBlendedLiquidationThreshold(): Decimal {
    const totalValue = this.computeTotalCollateralValue();
    if (totalValue.isZero()) {
      return Decimal.zero();
    }

    const discountedValue = this.positions.reduce(
      (total, position) =>
        total.add(
          positionValue(position).mul(
            position.liquidationModel.liquidationThreshold
          )
        ),
      Decimal.zero()
    );

    return discountedValue.div(totalValue);
  }

  /**
   * Value-weighted max loan-to-value, `sum(value * maxLtv) / sum(value)`, and
   * zero for a basket holding no value, for the same reason as the threshold.
   */
  computeBlendedMaxLoanToValue(): Decimal {
    const totalValue = this.computeTotalCollateralValue();
    if (totalValue.isZero()) {
      return Decimal.zero();
    }

    const borrowableValue = this.positions.reduce(
      (total, position) =>
        total.add(
          positionValue(position).mul(position.liquidationModel.maxLoanToValue)
        ),
      Decimal.zero()
    );

    return borrowableValue.div(totalValue);
  }

  /**
   * Blended health factor, `sum(value * threshold) / debt`, so the basket sits
   * at its liquidation boundary when the result is 1.0.
   *
   * Returns `undefined` when there is no debt, since the basket can never be
   * liquidated and no finite factor describes it. Throws on a negative debt or
   * price, matching `LiquidationParameterModel`.
   */
  computeHealthFactor(debt: Decimal): Decimal | undefined {
    assertNonNegative(debt, "Debt");
    for (const position of this.positions) {
      assertNonNegative(
        position.amount,
        `Collateral amount for ${position.asset}`
      );
      assertNonNegative(position.price, `Price for ${position.asset}`);
    }

    if (debt.isZero()) {
      return undefined;
    }

    const discountedValue = this.positions.reduce(
      (total, position) =>
        total.add(
          positionValue(position).mul(
            position.liquidationModel.liquidationThreshold
          )
        ),
      Decimal.zero()
    );

    return discountedValue.div(debt);
  }

  /**
   * Deterministic plan for unwinding `requiredDebtRepayment` of debt from the
   * basket. Each order sells enough of one asset to raise `debtRepaidValue` of
   * quote currency.
   *
   * - `highest-risk-first` draws on the lowest liquidation threshold first.
   * - `lowest-liquidity-penalty-first` draws on the cheapest penalty first.
   * - `pro-rata` spreads the repayment in proportion to position value.
   *
   * Positions with no amount or no price are skipped, and a request of zero or
   * less is a no-op rather than an error. When the basket holds less than the
   * request, the plan repays what it can and the `debtRepaidValue` values sum to
   * less than `requiredDebtRepayment`, so the caller can read the shortfall off
   * the plan.
   */
  computeDeleveragePlan(requiredDebtRepayment: Decimal): DeleverageOrder[] {
    if (requiredDebtRepayment.lte(Decimal.zero())) {
      return [];
    }

    const sellable = this.positions.filter(
      (position) => !position.amount.isZero() && !position.price.isZero()
    );
    if (sellable.length === 0) {
      return [];
    }

    return this.deleveragePolicy === "pro-rata"
      ? this.proRataPlan(sellable, requiredDebtRepayment)
      : this.sequentialPlan(sellable, requiredDebtRepayment);
  }

  private proRataPlan(
    sellable: CollateralPosition[],
    requiredDebtRepayment: Decimal
  ): DeleverageOrder[] {
    const holdings = sellable.map((position) => ({
      position,
      value: positionValue(position),
    }));
    const totalValue = holdings.reduce(
      (total, holding) => total.add(holding.value),
      Decimal.zero()
    );
    if (totalValue.isZero()) {
      return [];
    }

    const orders: DeleverageOrder[] = [];
    let remaining = requiredDebtRepayment;

    // Each position takes its share of the original request rather than of what
    // is still outstanding, so the slices stay proportional with more than two
    // positions. The last one takes the remainder, which absorbs the rounding
    // at scale 7 instead of leaving an unallocated slice behind. A slice that
    // rounds to nothing is dropped rather than recorded as a zero order.
    for (const [index, holding] of holdings.entries()) {
      const isLast = index === holdings.length - 1;
      const debtToCover = isLast
        ? lowest(holding.value, remaining)
        : lowest(
            requiredDebtRepayment.mul(holding.value).div(totalValue),
            holding.value,
            remaining
          );

      if (debtToCover.isZero()) {
        continue;
      }

      orders.push(toOrder(holding.position, debtToCover));
      remaining = remaining.sub(debtToCover);
    }

    return orders;
  }

  private sequentialPlan(
    sellable: CollateralPosition[],
    requiredDebtRepayment: Decimal
  ): DeleverageOrder[] {
    const ordered = [...sellable].sort((first, second) => {
      const byPolicy =
        this.deleveragePolicy === "highest-risk-first"
          ? compare(
              first.liquidationModel.liquidationThreshold,
              second.liquidationModel.liquidationThreshold
            )
          : compare(
              first.liquidationModel.liquidationPenalty,
              second.liquidationModel.liquidationPenalty
            );

      return byPolicy !== 0
        ? byPolicy
        : compareAsset(first.asset, second.asset);
    });

    const orders: DeleverageOrder[] = [];
    let remaining = requiredDebtRepayment;

    for (const position of ordered) {
      if (remaining.isZero()) {
        break;
      }

      const value = positionValue(position);
      const debtToCover = value.gte(remaining) ? remaining : value;
      if (debtToCover.isZero()) {
        continue;
      }

      orders.push(toOrder(position, debtToCover));
      remaining = remaining.sub(debtToCover);
    }

    return orders;
  }
}
