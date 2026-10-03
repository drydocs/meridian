import { FixedPointDecimal } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Inclusive minimum leverage accepted by sizePosition. */
export const MIN_LEVERAGE = FixedPointDecimal.fromString("1");

/**
 * Inclusive maximum leverage accepted by sizePosition.
 * 20× keeps the strategy well within typical exchange initial-margin limits
 * and prevents unreasonably large notionals from upstream bugs.
 */
export const MAX_LEVERAGE = FixedPointDecimal.fromString("20");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when targetLeverage is outside the sane range [MIN_LEVERAGE, MAX_LEVERAGE]
 * or is not a positive value.
 */
export class InvalidLeverageError extends Error {
  readonly leverage: FixedPointDecimal;
  readonly minLeverage: FixedPointDecimal;
  readonly maxLeverage: FixedPointDecimal;

  constructor(leverage: FixedPointDecimal) {
    super(
      `Invalid leverage ${leverage.toString()}: must be in [${MIN_LEVERAGE.toString()}, ${MAX_LEVERAGE.toString()}]`
    );
    this.name = "InvalidLeverageError";
    this.leverage = leverage;
    this.minLeverage = MIN_LEVERAGE;
    this.maxLeverage = MAX_LEVERAGE;
  }
}

/**
 * Thrown when capital is zero or negative — sizing requires a strictly positive
 * capital amount to produce meaningful notionals.
 */
export class InvalidCapitalError extends Error {
  readonly capital: FixedPointDecimal;

  constructor(capital: FixedPointDecimal) {
    super(
      `Invalid capital ${capital.toString()}: must be strictly positive`
    );
    this.name = "InvalidCapitalError";
    this.capital = capital;
  }
}

export function isInvalidLeverageError(
  error: unknown
): error is InvalidLeverageError {
  return error instanceof InvalidLeverageError;
}

export function isInvalidCapitalError(
  error: unknown
): error is InvalidCapitalError {
  return error instanceof InvalidCapitalError;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SizePositionParams {
  /**
   * Available collateral expressed as a FixedPointDecimal quantity in the
   * quote asset (e.g. USDC).  Must be strictly positive.
   */
  capital: FixedPointDecimal;

  /**
   * Desired gross leverage for each leg.  Must be in [MIN_LEVERAGE,
   * MAX_LEVERAGE] (inclusive).  A leverage of 2× means each leg's notional
   * is 2× the capital, with the capital itself serving as margin.
   */
  targetLeverage: FixedPointDecimal;

  /**
   * Current spot prices keyed by asset symbol.  Used to express notionals in
   * a consistent quote currency.  The caller is responsible for supplying
   * prices at the desired simulation timestamp via a PriceFeed.
   */
  prices: Record<string, FixedPointDecimal>;
}

export interface SizePositionResult {
  /**
   * Notional value of the long (spot) leg, in the quote asset.
   *   longNotional = capital × targetLeverage
   */
  longNotional: FixedPointDecimal;

  /**
   * Notional value of the short (hedge) leg, in the quote asset.
   * Equal to longNotional — the hedge is sized 1:1 to make the position
   * delta-neutral.
   */
  shortNotional: FixedPointDecimal;

  /**
   * Margin required per leg, in the quote asset.
   *   margin = longNotional / targetLeverage  (= capital)
   *
   * Both legs require the same margin because they share the same leverage
   * target.  The total capital consumed is 2 × margin.
   */
  marginPerLeg: FixedPointDecimal;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Compute the long notional, short notional, and per-leg margin for a
 * delta-neutral spot/perp position given available capital and a target
 * leverage.
 *
 * All arithmetic uses FixedPointDecimal (bigint-backed, 7 decimal places) —
 * no floating-point values are introduced at any step.
 *
 * @throws {InvalidCapitalError}  if capital ≤ 0
 * @throws {InvalidLeverageError} if targetLeverage ∉ [MIN_LEVERAGE, MAX_LEVERAGE]
 */
export function sizePosition(params: SizePositionParams): SizePositionResult {
  const { capital, targetLeverage } = params;

  // --- Validate capital ---
  if (!capital.isPositive()) {
    throw new InvalidCapitalError(capital);
  }

  // --- Validate leverage ---
  if (
    targetLeverage.compareTo(MIN_LEVERAGE) < 0 ||
    targetLeverage.compareTo(MAX_LEVERAGE) > 0 ||
    !targetLeverage.isPositive()
  ) {
    throw new InvalidLeverageError(targetLeverage);
  }

  // --- Sizing math ---
  //
  // longNotional  = capital × leverage
  // shortNotional = longNotional          (1:1 delta-neutral hedge)
  // marginPerLeg  = longNotional / leverage  (= capital, sanity: allocates
  //                                           exactly the capital provided)
  //
  const longNotional = capital.multiply(targetLeverage);
  const shortNotional = longNotional;
  const marginPerLeg = longNotional.divide(targetLeverage);

  return { longNotional, shortNotional, marginPerLeg };
}
