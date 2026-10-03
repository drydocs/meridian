import { FixedPointDecimal } from "@meridian/fixed-point";

/**
 * Sane leverage bounds for delta-neutral sizing. Leverage below 1x would
 * leave capital unused; above 10x is rejected as unsafe for a hedged book.
 */
export const MIN_TARGET_LEVERAGE = 1;
export const MAX_TARGET_LEVERAGE = 10;

export type SizingErrorCode =
  | "NON_POSITIVE_CAPITAL"
  | "INVALID_LEVERAGE"
  | "INVALID_PRICE";

export class SizingError extends Error {
  readonly code: SizingErrorCode;

  constructor(code: SizingErrorCode, message: string) {
    super(message);
    this.name = "SizingError";
    this.code = code;
  }
}

export interface SizingPrices {
  /** Spot price of the long leg. */
  readonly long: FixedPointDecimal;
  /** Perp/futures price of the short hedge leg. */
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
  /** Margin required by the long spot leg. */
  readonly longMargin: FixedPointDecimal;
  /** Margin required by the short hedge leg. */
  readonly shortMargin: FixedPointDecimal;
}

const ZERO = new FixedPointDecimal(0);
const ONE = new FixedPointDecimal(1);

/**
 * Compute delta-neutral position sizing from available capital and a target
 * leverage. The total notional is `capital * targetLeverage`, split evenly
 * across the long spot and short hedge legs so the book stays delta-neutral.
 * Each leg's margin is its notional divided by the target leverage.
 */
export function sizePosition(params: SizePositionParams): PositionSize {
  const { capital, targetLeverage, prices } = params;

  if (capital.lte(ZERO)) {
    throw new SizingError(
      "NON_POSITIVE_CAPITAL",
      "capital must be positive",
    );
  }

  if (targetLeverage.lt(new FixedPointDecimal(MIN_TARGET_LEVERAGE)) ||
      targetLeverage.gt(new FixedPointDecimal(MAX_TARGET_LEVERAGE))) {
    throw new SizingError(
      "INVALID_LEVERAGE",
      `targetLeverage must be between ${MIN_TARGET_LEVERAGE} and ${MAX_TARGET_LEVERAGE}`,
    );
  }

  if (prices.long.lte(ZERO) || prices.short.lte(ZERO)) {
    throw new SizingError(
      "INVALID_PRICE",
      "prices must be positive",
    );
  }

  const totalNotional = capital.mul(targetLeverage);
  const half = new FixedPointDecimal("0.5");
  const longNotional = totalNotional.mul(half);
  const shortNotional = totalNotional.sub(longNotional);

  const longMargin = longNotional.div(targetLeverage);
  const shortMargin = shortNotional.div(targetLeverage);

  return {
    longNotional,
    shortNotional,
    longMargin,
    shortMargin,
  };
}
