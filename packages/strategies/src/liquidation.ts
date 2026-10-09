import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, PriceFeed, SimulationTimestamp } from "./types";

/**
 * A leveraged position: collateral held against a debt denominated in a second
 * asset. Both fields are amounts of their own asset, not values; values are
 * derived from the price feed at the timestamp being evaluated.
 */
export interface LeveragedPosition {
  readonly id: string;
  readonly collateralAsset: AssetSymbol;
  readonly collateralAmount: FixedPointDecimal;
  readonly debtAsset: AssetSymbol;
  readonly debtAmount: FixedPointDecimal;
}

/**
 * Amounts are not all in the same unit. `debtCleared` is denominated in the
 * position's debt asset, `collateralSeized` in its collateral asset, and
 * `realizedLoss` in the quote currency the prices are quoted in, which is what
 * lets losses on positions with different debt assets be summed.
 */
export interface LiquidationEvent {
  readonly positionId: string;
  readonly timestamp: SimulationTimestamp;
  /** The factor that triggered the liquidation, rounded to 7 decimal places. */
  readonly healthFactor: FixedPointDecimal;
  readonly debtCleared: FixedPointDecimal;
  readonly collateralSeized: FixedPointDecimal;
  /** Debt the seized collateral could not cover, written off with the position. */
  readonly realizedLoss: FixedPointDecimal;
}

/** Receives each liquidation so a run can count them. */
export interface MetricsCollector {
  emit(event: LiquidationEvent): void;
}

/** Open positions and the debt written off against them so far. */
export interface LiquidationBook {
  readonly positions: ReadonlyMap<string, LeveragedPosition>;
  readonly realizedLosses: FixedPointDecimal;
}

export interface LiquidationTickResult {
  readonly book: LiquidationBook;
  readonly liquidations: readonly LiquidationEvent[];
}

/**
 * Liquidates positions whose health factor falls strictly below 1.0, which is
 * the rule `LiquidationParameterModel.isLiquidatable` states. A position
 * sitting exactly on 1.0 is safe, and a position carrying no debt has no health
 * factor and is never liquidated.
 *
 * A liquidation seizes collateral worth the debt plus the model's penalty,
 * capped at the collateral actually held, and writes off whatever debt that
 * leaves uncovered. Positions are immutable, so a tick returns a new book and
 * reports the liquidations it applied.
 *
 * Values are computed in `Decimal`, which is what the model takes, so they round
 * half-up rather than truncating the way `FixedPointDecimal` does.
 */
export class LiquidationEngine {
  readonly #priceFeed: PriceFeed;
  readonly #model: LiquidationParameterModel;
  readonly #metrics: MetricsCollector;

  constructor(
    priceFeed: PriceFeed,
    model: LiquidationParameterModel,
    metrics: MetricsCollector
  ) {
    this.#priceFeed = priceFeed;
    this.#model = model;
    this.#metrics = metrics;
  }

  /**
   * Health factor from the model, or `undefined` when the position carries no
   * debt and so can never be liquidated.
   */
  computeHealthFactor(
    position: LeveragedPosition,
    timestamp: SimulationTimestamp
  ): FixedPointDecimal | undefined {
    const healthFactor = this.#model.computeHealthFactor(
      this.#collateralValue(position, timestamp),
      this.#debtValue(position, timestamp)
    );

    return healthFactor === undefined
      ? undefined
      : LiquidationEngine.#toFixedPoint(healthFactor);
  }

  processTick(
    book: LiquidationBook,
    timestamp: SimulationTimestamp
  ): LiquidationTickResult {
    const positions = new Map(book.positions);
    const liquidations: LiquidationEvent[] = [];
    let realizedLosses = LiquidationEngine.#toDecimal(book.realizedLosses);

    for (const [key, position] of book.positions) {
      const event = this.#liquidate(position, timestamp);
      if (event === undefined) continue;

      liquidations.push(event);
      realizedLosses = realizedLosses.add(
        LiquidationEngine.#toDecimal(event.realizedLoss)
      );
      positions.set(key, {
        ...position,
        collateralAmount: position.collateralAmount.sub(event.collateralSeized),
        debtAmount: FixedPointDecimal.fromStroops(0n),
      });
    }

    // Emitted only after the whole tick has been evaluated, so a tick that
    // throws cannot leave the collector ahead of the state the caller receives.
    for (const event of liquidations) {
      this.#metrics.emit(event);
    }

    return {
      book: {
        positions,
        realizedLosses: LiquidationEngine.#toFixedPoint(realizedLosses),
      },
      liquidations,
    };
  }

  #liquidate(
    position: LeveragedPosition,
    timestamp: SimulationTimestamp
  ): LiquidationEvent | undefined {
    const collateralPrice = this.#price(position.collateralAsset, timestamp);
    const collateralValue = LiquidationEngine.#toDecimal(
      position.collateralAmount
    ).mul(collateralPrice);
    const debtValue = this.#debtValue(position, timestamp);

    const healthFactor = this.#model.computeHealthFactor(
      collateralValue,
      debtValue
    );
    if (healthFactor === undefined || !healthFactor.lt(Decimal.one())) {
      return undefined;
    }

    const requiredValue = debtValue.mul(
      Decimal.one().add(this.#model.liquidationPenalty)
    );
    const requiredAmount = requiredValue.div(collateralPrice);
    const collateralHeld = LiquidationEngine.#toDecimal(
      position.collateralAmount
    );
    // Capped means the collateral could not raise the debt and the penalty, so
    // the position is the only case where debt can be left uncovered. Without
    // the cap the seizure was sized to cover both, and any remaining shortfall
    // is rounding on the seizure rather than debt nobody paid.
    const capped = requiredAmount.gte(collateralHeld);
    const collateralSeized = capped ? collateralHeld : requiredAmount;
    const seizedValue = collateralSeized.mul(collateralPrice);
    const realizedLoss =
      capped && debtValue.gt(seizedValue)
        ? debtValue.sub(seizedValue)
        : Decimal.zero();

    return {
      positionId: position.id,
      timestamp,
      healthFactor: LiquidationEngine.#toFixedPoint(healthFactor),
      debtCleared: position.debtAmount,
      collateralSeized: LiquidationEngine.#toFixedPoint(collateralSeized),
      realizedLoss: LiquidationEngine.#toFixedPoint(realizedLoss),
    };
  }

  #collateralValue(
    position: LeveragedPosition,
    timestamp: SimulationTimestamp
  ): Decimal {
    return LiquidationEngine.#toDecimal(position.collateralAmount).mul(
      this.#price(position.collateralAsset, timestamp)
    );
  }

  #debtValue(
    position: LeveragedPosition,
    timestamp: SimulationTimestamp
  ): Decimal {
    return LiquidationEngine.#toDecimal(position.debtAmount).mul(
      this.#price(position.debtAsset, timestamp)
    );
  }

  /**
   * A price that is not strictly positive is not a usable price for a stable
   * asset, so it is rejected. Letting a zero through would flatten the value it
   * multiplies, which on the debt side reads as a position carrying no debt and
   * quietly exempts it from liquidation.
   */
  #price(asset: AssetSymbol, timestamp: SimulationTimestamp): Decimal {
    const price = LiquidationEngine.#toDecimal(
      this.#priceFeed.getSpotPrice(asset, timestamp)
    );
    if (!price.isPositive()) {
      throw new RangeError(`Price for ${asset} must be greater than zero`);
    }
    return price;
  }

  static #toDecimal(value: FixedPointDecimal): Decimal {
    return Decimal.fromStroops(value.toStroops());
  }

  static #toFixedPoint(value: Decimal): FixedPointDecimal {
    return FixedPointDecimal.fromStroops(value.toStroops());
  }
}
