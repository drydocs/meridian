import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";
import type { AssetSymbol } from "./types";

/**
 * Deterministic delta-neutral strategy core.
 *
 * A delta-neutral position pairs a spot long in a risk asset with an inverse
 * (coin-margined) perpetual short whose notional is fixed in quote terms. The
 * base delta of the short leg is `-shortNotional / spotPrice`, so unlike a
 * linear hedge the position drifts as the price moves — that drift is exactly
 * what the rebalance trigger watches.
 *
 * Every monetary value is a `FixedPointDecimal` (bigint stroops); no
 * floating-point arithmetic is used anywhere. The module is pure and
 * network-free: callers source prices from a `PriceFeed` and decide when to
 * step the simulation.
 */

/** Inclusive minimum leverage accepted by the sizing helpers. */
export const MIN_LEVERAGE = FixedPointDecimal.fromString("1");

/**
 * Inclusive maximum leverage accepted by the sizing helpers. 20× keeps the
 * strategy inside typical exchange initial-margin limits and stops upstream
 * bugs from producing unreasonably large notionals.
 */
export const MAX_LEVERAGE = FixedPointDecimal.fromString("20");

/**
 * Default rebalance band: trigger once the net delta exceeds 5% of the long
 * leg's mark-to-market notional.
 */
export const DEFAULT_REBALANCE_BAND = FixedPointDecimal.fromString("0.05");

// ---------------------------------------------------------------------------
// Fixed-point helpers
//
// `FixedPointDecimal` on `main` exposes construction, comparison and
// conversion only, so the arithmetic this module needs lives here and is
// expressed entirely in bigint stroops. Values carry one STROOPS_PER_UNIT
// factor each, so products and quotients are rescaled exactly once. Division
// truncates toward zero, the same rounding Stellar protocol math uses.
// ---------------------------------------------------------------------------

function mul(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(
    (a.toStroops() * b.toStroops()) / STROOPS_PER_UNIT
  );
}

function div(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  const divisor = b.toStroops();
  if (divisor === 0n) {
    throw new FixedPointDivisionByZeroError();
  }
  return FixedPointDecimal.fromStroops(
    (a.toStroops() * STROOPS_PER_UNIT) / divisor
  );
}

function add(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(a.toStroops() + b.toStroops());
}

function sub(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(a.toStroops() - b.toStroops());
}

function abs(value: FixedPointDecimal): FixedPointDecimal {
  const stroops = value.toStroops();
  return stroops < 0n ? FixedPointDecimal.fromStroops(-stroops) : value;
}

function isZero(value: FixedPointDecimal): boolean {
  return value.toStroops() === 0n;
}

function isPositive(value: FixedPointDecimal): boolean {
  return value.toStroops() > 0n;
}

function scaleByIntervals(
  value: FixedPointDecimal,
  intervals: number
): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(value.toStroops() * BigInt(intervals));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the fixed-point divisor is zero. */
export class FixedPointDivisionByZeroError extends Error {
  constructor() {
    super("FixedPointDecimal: division by zero");
    this.name = "FixedPointDivisionByZeroError";
  }
}

/** Thrown when capital is zero or negative. */
export class InvalidCapitalError extends Error {
  readonly capital: FixedPointDecimal;

  constructor(capital: FixedPointDecimal) {
    super(`Invalid capital ${capital.toString()}: must be strictly positive`);
    this.name = "InvalidCapitalError";
    this.capital = capital;
  }
}

/** Thrown when leverage falls outside [MIN_LEVERAGE, MAX_LEVERAGE]. */
export class InvalidLeverageError extends Error {
  readonly leverage: FixedPointDecimal;
  readonly minLeverage: FixedPointDecimal;
  readonly maxLeverage: FixedPointDecimal;

  constructor(leverage: FixedPointDecimal) {
    super(
      `Invalid leverage ${leverage.toString()}: must be in ` +
        `[${MIN_LEVERAGE.toString()}, ${MAX_LEVERAGE.toString()}]`
    );
    this.name = "InvalidLeverageError";
    this.leverage = leverage;
    this.minLeverage = MIN_LEVERAGE;
    this.maxLeverage = MAX_LEVERAGE;
  }
}

/** Thrown when a non-positive price is supplied. */
export class InvalidPriceError extends Error {
  readonly price: FixedPointDecimal;

  constructor(price: FixedPointDecimal) {
    super(`Invalid price ${price.toString()}: must be strictly positive`);
    this.name = "InvalidPriceError";
    this.price = price;
  }
}

/** Thrown when a rebalance band is negative. */
export class InvalidRebalanceBandError extends Error {
  readonly band: FixedPointDecimal;

  constructor(band: FixedPointDecimal) {
    super(`Invalid rebalance band ${band.toString()}: must not be negative`);
    this.name = "InvalidRebalanceBandError";
    this.band = band;
  }
}

/** Thrown when sizing truncates to a zero position quantity. */
export class ZeroQuantityError extends Error {
  readonly notional: FixedPointDecimal;
  readonly price: FixedPointDecimal;

  constructor(notional: FixedPointDecimal, price: FixedPointDecimal) {
    super(
      `Position quantity rounds to zero: notional ${notional.toString()} ` +
        `is below price ${price.toString()}`
    );
    this.name = "ZeroQuantityError";
    this.notional = notional;
    this.price = price;
  }
}

/**
 * Thrown when a rebalance order does not match the adjustment required at the
 * price it is being applied at — i.e. the order was computed at a stale price.
 */
export class StaleRebalanceOrderError extends Error {
  readonly orderNotional: FixedPointDecimal;
  readonly requiredNotional: FixedPointDecimal;

  constructor(
    orderNotional: FixedPointDecimal,
    requiredNotional: FixedPointDecimal
  ) {
    super(
      `Rebalance order notional ${orderNotional.toString()} does not match ` +
        `the required adjustment ${requiredNotional.toString()}`
    );
    this.name = "StaleRebalanceOrderError";
    this.orderNotional = orderNotional;
    this.requiredNotional = requiredNotional;
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

export function isStaleRebalanceOrderError(
  error: unknown
): error is StaleRebalanceOrderError {
  return error instanceof StaleRebalanceOrderError;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeltaNeutralConfig {
  /** Asset the margin/collateral is denominated in. */
  collateralAsset: AssetSymbol;
  /** Asset being held long on the spot leg. */
  riskAsset: AssetSymbol;
  /** Margin posted for one leg, in the quote asset. Must be positive. */
  capital: FixedPointDecimal;
  /** Gross leverage per leg, in [1, 20]. */
  leverage: FixedPointDecimal;
  /** Risk-asset price at the moment the position is opened. */
  entryPrice: FixedPointDecimal;
  /** Absolute delta ratio at which a rebalance fires. Defaults to 5%. */
  rebalanceBand?: FixedPointDecimal;
}

export interface DeltaNeutralPosition {
  readonly collateralAsset: AssetSymbol;
  readonly riskAsset: AssetSymbol;
  /** Margin posted for one leg, in the quote asset. */
  readonly capital: FixedPointDecimal;
  readonly leverage: FixedPointDecimal;
  readonly entryPrice: FixedPointDecimal;
  readonly rebalanceBand: FixedPointDecimal;
  /** Spot long size, in risk-asset base units. */
  readonly longQuantity: FixedPointDecimal;
  /** Inverse-perp short notional, in quote units. */
  readonly shortNotional: FixedPointDecimal;
}

export interface DeltaSnapshot {
  /** Net exposure in base units; positive means net long. */
  readonly baseDelta: FixedPointDecimal;
  /** Net exposure in quote units; positive means net long. */
  readonly notionalDelta: FixedPointDecimal;
  /** Net exposure as a fraction of the long leg's mark-to-market notional. */
  readonly deltaRatio: FixedPointDecimal;
}

export type RebalanceSide = "buy" | "sell";

export interface RebalanceOrder {
  /** `sell` increases the short notional, `buy` reduces it. */
  readonly side: RebalanceSide;
  /** Base units to trade. Never negative. */
  readonly quantity: FixedPointDecimal;
  /** Quote notional to trade. Never negative. */
  readonly notional: FixedPointDecimal;
  /** Signed delta ratio that fired the trigger. */
  readonly deltaRatio: FixedPointDecimal;
}

export interface FundingAccrual {
  readonly intervals: number;
  readonly ratePerInterval: FixedPointDecimal;
  /** Short notional the accrual was charged against. */
  readonly notional: FixedPointDecimal;
  /** Signed payment: positive means the position receives funding. */
  readonly payment: FixedPointDecimal;
}

export interface DeltaNeutralSizeParams {
  capital: FixedPointDecimal;
  leverage: FixedPointDecimal;
  price: FixedPointDecimal;
}

export interface DeltaNeutralSize {
  /** Notional carried by each leg, in the quote asset. */
  readonly notional: FixedPointDecimal;
  /** Margin committed to each leg; equals `capital` when exact. */
  readonly marginPerLeg: FixedPointDecimal;
  /** Base units for the spot long. */
  readonly longQuantity: FixedPointDecimal;
  /** Quote notional for the inverse-perp short. */
  readonly shortNotional: FixedPointDecimal;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertValidCapital(capital: FixedPointDecimal): void {
  if (!isPositive(capital)) {
    throw new InvalidCapitalError(capital);
  }
}

function assertValidLeverage(leverage: FixedPointDecimal): void {
  if (
    leverage.compareTo(MIN_LEVERAGE) < 0 ||
    leverage.compareTo(MAX_LEVERAGE) > 0
  ) {
    throw new InvalidLeverageError(leverage);
  }
}

function assertValidPrice(price: FixedPointDecimal): void {
  if (!isPositive(price)) {
    throw new InvalidPriceError(price);
  }
}

function assertValidBand(band: FixedPointDecimal): void {
  if (band.toStroops() < 0n) {
    throw new InvalidRebalanceBandError(band);
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Size both legs for a target leverage.
 *
 * `notional = capital × leverage` and `longQuantity = notional / price`. The
 * short notional is then re-derived from the *quantized* long quantity so the
 * position opens exactly delta-neutral; the cost is at most one stroop of base
 * quantity left unhedged, i.e. less than `1e-7 × price` quote units.
 *
 * @throws {InvalidCapitalError} if capital ≤ 0
 * @throws {InvalidLeverageError} if leverage ∉ [1, 20]
 * @throws {InvalidPriceError} if price ≤ 0
 * @throws {ZeroQuantityError} if the quantity truncates to zero
 */
export function sizeDeltaNeutralPosition(
  params: DeltaNeutralSizeParams
): DeltaNeutralSize {
  const { capital, leverage, price } = params;
  assertValidCapital(capital);
  assertValidLeverage(leverage);
  assertValidPrice(price);

  const notional = mul(capital, leverage);
  const longQuantity = div(notional, price);
  if (isZero(longQuantity)) {
    throw new ZeroQuantityError(notional, price);
  }

  return {
    notional,
    marginPerLeg: div(notional, leverage),
    longQuantity,
    shortNotional: mul(longQuantity, price),
  };
}

/**
 * Open a delta-neutral position at `entryPrice`.
 *
 * @throws see {@link sizeDeltaNeutralPosition}
 * @throws {InvalidRebalanceBandError} if the band is negative
 */
export function openDeltaNeutralPosition(
  config: DeltaNeutralConfig
): DeltaNeutralPosition {
  const band = config.rebalanceBand ?? DEFAULT_REBALANCE_BAND;
  assertValidBand(band);

  const size = sizeDeltaNeutralPosition({
    capital: config.capital,
    leverage: config.leverage,
    price: config.entryPrice,
  });

  return {
    collateralAsset: config.collateralAsset,
    riskAsset: config.riskAsset,
    capital: config.capital,
    leverage: config.leverage,
    entryPrice: config.entryPrice,
    rebalanceBand: band,
    longQuantity: size.longQuantity,
    shortNotional: size.shortNotional,
  };
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Net delta of the position at `spotPrice`.
 *
 * The spot long is marked to market (`longQuantity × spotPrice`) while the
 * inverse-perp short keeps its fixed quote notional, so a price move leaves a
 * residual exposure instead of cancelling out.
 *
 * @throws {InvalidPriceError} if price ≤ 0
 */
export function computeDelta(
  position: DeltaNeutralPosition,
  spotPrice: FixedPointDecimal
): DeltaSnapshot {
  assertValidPrice(spotPrice);

  const longNotional = mul(position.longQuantity, spotPrice);
  const notionalDelta = sub(longNotional, position.shortNotional);
  const baseDelta = div(notionalDelta, spotPrice);
  const deltaRatio = isZero(longNotional)
    ? FixedPointDecimal.fromStroops(0n)
    : div(notionalDelta, longNotional);

  return { baseDelta, notionalDelta, deltaRatio };
}

/**
 * Whether the position has drifted far enough to rebalance.
 *
 * The band edge is inclusive: a delta ratio exactly equal to the band fires.
 */
export function shouldRebalance(
  delta: DeltaSnapshot,
  band: FixedPointDecimal
): boolean {
  assertValidBand(band);
  return abs(delta.deltaRatio).compareTo(band) >= 0;
}

// ---------------------------------------------------------------------------
// Rebalance trigger and order
// ---------------------------------------------------------------------------

/**
 * Build the order that returns the position to neutrality, or `null` when the
 * delta sits inside the band.
 *
 * Rebalancing restores the short notional to the long leg's current
 * mark-to-market value by trading the risk asset: `sell` when the position has
 * drifted net long (top up the hedge), `buy` when it has drifted net short.
 *
 * @throws {InvalidPriceError} if price ≤ 0
 * @throws {InvalidRebalanceBandError} if the band is negative
 */
export function planRebalance(
  position: DeltaNeutralPosition,
  spotPrice: FixedPointDecimal,
  band?: FixedPointDecimal
): RebalanceOrder | null {
  const effectiveBand = band ?? position.rebalanceBand;
  const delta = computeDelta(position, spotPrice);
  if (!shouldRebalance(delta, effectiveBand)) {
    return null;
  }

  const targetShortNotional = mul(position.longQuantity, spotPrice);
  const adjustment = sub(targetShortNotional, position.shortNotional);

  return {
    side: adjustment.toStroops() > 0n ? "sell" : "buy",
    quantity: div(abs(adjustment), spotPrice),
    notional: abs(adjustment),
    deltaRatio: delta.deltaRatio,
  };
}

/**
 * Apply a rebalance order at the price it was planned at, returning the neutral
 * position. Orders planned at a different price are rejected so a stale plan
 * can never leave the book silently unhedged.
 *
 * @throws {StaleRebalanceOrderError} if the order does not match the required
 * adjustment at `spotPrice`
 */
export function applyRebalance(
  position: DeltaNeutralPosition,
  order: RebalanceOrder,
  spotPrice: FixedPointDecimal
): DeltaNeutralPosition {
  const targetShortNotional = mul(position.longQuantity, spotPrice);
  const required = abs(sub(targetShortNotional, position.shortNotional));

  if (order.notional.toStroops() !== required.toStroops()) {
    throw new StaleRebalanceOrderError(order.notional, required);
  }

  return { ...position, shortNotional: targetShortNotional };
}

// ---------------------------------------------------------------------------
// Funding accrual
// ---------------------------------------------------------------------------

/**
 * Accrue funding over `intervals` periods on the short notional.
 *
 * Sign convention: a positive rate means longs pay shorts, so the short leg
 * *receives* and `payment` is positive. A negative rate means the short pays
 * and `payment` is negative. Funding is linear in the number of intervals and
 * is never compounded here.
 *
 * @throws {RangeError} if `intervals` is not a non-negative integer
 */
export function accrueFunding(
  position: DeltaNeutralPosition,
  ratePerInterval: FixedPointDecimal,
  intervals: number
): FundingAccrual {
  if (!Number.isInteger(intervals) || intervals < 0) {
    throw new RangeError(
      `Funding intervals must be a non-negative integer, got ${intervals}`
    );
  }

  const perInterval = mul(position.shortNotional, ratePerInterval);

  return {
    intervals,
    ratePerInterval,
    notional: position.shortNotional,
    payment: scaleByIntervals(perInterval, intervals),
  };
}

/**
 * Equity after applying a funding accrual: posted capital plus the signed
 * payment. Positive funding raises equity, negative funding draws it down.
 */
export function equityAfterFunding(
  position: DeltaNeutralPosition,
  accrual: FundingAccrual
): FixedPointDecimal {
  return add(position.capital, accrual.payment);
}
