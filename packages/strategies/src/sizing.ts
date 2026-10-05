import { Decimal } from "./decimal";
import { FixedPointDecimal } from "./types";

/**
 * Intermediate precision for the sizing arithmetic. Finer than the stroop
 * scale of the inputs and outputs, so the intermediate products round once at
 * the end rather than at every step.
 */
const SIZING_WORKING_SCALE = 18;

const MIN_LEVERAGE = "1";
const MAX_LEVERAGE = "20";

/** Inclusive bounds on the gross leverage applied to each leg. */
export const MIN_TARGET_LEVERAGE = FixedPointDecimal.fromString(MIN_LEVERAGE);
export const MAX_TARGET_LEVERAGE = FixedPointDecimal.fromString(MAX_LEVERAGE);

export type SizingErrorCode =
  "NON_POSITIVE_CAPITAL" | "INVALID_LEVERAGE" | "INVALID_PRICE";

export class SizingError extends Error {
  readonly code: SizingErrorCode;

  constructor(code: SizingErrorCode, message: string) {
    super(message);
    this.name = "SizingError";
    this.code = code;
  }
}

export function isSizingError(error: unknown): error is SizingError {
  return error instanceof SizingError;
}

export interface SizingPrices {
  /** Spot price of the long leg. */
  readonly long: FixedPointDecimal;
  /** Perp price of the short hedge leg. */
  readonly short: FixedPointDecimal;
}

export interface SizePositionParams {
  readonly capital: FixedPointDecimal;
  readonly targetLeverage: FixedPointDecimal;
  readonly prices: SizingPrices;
}

export interface PositionSize {
  /** Notional of the long spot leg. */
  readonly longNotional: FixedPointDecimal;
  /** Notional of the short hedge leg. */
  readonly shortNotional: FixedPointDecimal;
  /** Margin the long spot leg posts. */
  readonly longMargin: FixedPointDecimal;
  /** Margin the short hedge leg posts. */
  readonly shortMargin: FixedPointDecimal;
}

function toDecimal(value: FixedPointDecimal): Decimal {
  return Decimal.fromStroops(value.toStroops()).rescale(SIZING_WORKING_SCALE);
}

function toFixedPoint(value: Decimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(value.toStroops());
}

/**
 * Sizes a delta-neutral book. Total notional is `capital * targetLeverage`,
 * split evenly across the long spot leg and the short hedge leg, and each leg
 * posts `notional / targetLeverage` in margin, which leaves the margin per leg
 * equal to the capital.
 *
 * A 1:1 hedge makes the notional split independent of the leg prices. The
 * prices are still validated so a caller passing a scenario's prices through
 * fails fast on a malformed one.
 */
export function sizePosition(params: SizePositionParams): PositionSize {
  const capital = toDecimal(params.capital);
  const targetLeverage = toDecimal(params.targetLeverage);
  const longPrice = toDecimal(params.prices.long);
  const shortPrice = toDecimal(params.prices.short);

  if (!capital.isPositive()) {
    throw new SizingError(
      "NON_POSITIVE_CAPITAL",
      `Capital must be positive, received ${params.capital.toString()}`
    );
  }

  if (targetLeverage.lt(MIN_LEVERAGE) || targetLeverage.gt(MAX_LEVERAGE)) {
    throw new SizingError(
      "INVALID_LEVERAGE",
      `Target leverage must be between ${MIN_LEVERAGE} and ${MAX_LEVERAGE}, received ${params.targetLeverage.toString()}`
    );
  }

  if (!longPrice.isPositive() || !shortPrice.isPositive()) {
    throw new SizingError(
      "INVALID_PRICE",
      `Prices must be positive, received long ${params.prices.long.toString()} and short ${params.prices.short.toString()}`
    );
  }

  const longNotional = capital.mul(targetLeverage);
  const shortNotional = longNotional;

  return {
    longNotional: toFixedPoint(longNotional),
    shortNotional: toFixedPoint(shortNotional),
    longMargin: toFixedPoint(longNotional.div(targetLeverage)),
    shortMargin: toFixedPoint(shortNotional.div(targetLeverage)),
  };
}
