import { FixedPointDecimal } from "./types";
import type { AssetSymbol, PriceFeed, SimulationTimestamp } from "./types";
import type {
  Order,
  OrderSide,
  Strategy,
  StrategyContext,
  StrategyInitContext,
} from "./strategy";

// ---------------------------------------------------------------------------
// Fixed-point helpers
// ---------------------------------------------------------------------------
//
// `FixedPointDecimal` on `main` exposes construction and comparison but no
// arithmetic, so the delta-neutral core performs its bigint-stroop math here
// and hands every value back as a `FixedPointDecimal`. Nothing in this module
// ever touches an IEEE-754 float for money: the only `number` values are
// integer tick indices, timestamps and basis-point counts.

const STROOPS_PER_UNIT = 10_000_000n;
const BPS_DENOMINATOR = 10_000n;

const ZERO = FixedPointDecimal.fromStroops(0n);

function fpAdd(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(a.toStroops() + b.toStroops());
}

function fpSub(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(a.toStroops() - b.toStroops());
}

/** `a × b`, floored to the stroop scale. */
function fpMul(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(
    (a.toStroops() * b.toStroops()) / STROOPS_PER_UNIT
  );
}

/** `a ÷ b`, floored to the stroop scale. */
function fpDiv(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  const divisor = b.toStroops();
  if (divisor === 0n) {
    throw new RangeError("delta-neutral: division by zero");
  }
  return FixedPointDecimal.fromStroops(
    (a.toStroops() * STROOPS_PER_UNIT) / divisor
  );
}

function fpAbs(a: FixedPointDecimal): FixedPointDecimal {
  const stroops = a.toStroops();
  return FixedPointDecimal.fromStroops(stroops < 0n ? -stroops : stroops);
}

/** -1, 0 or 1. */
function fpSign(a: FixedPointDecimal): number {
  const stroops = a.toStroops();
  if (stroops < 0n) return -1;
  if (stroops > 0n) return 1;
  return 0;
}

function fpIsZero(a: FixedPointDecimal): boolean {
  return a.toStroops() === 0n;
}

/** `value × bps / 10_000`, floored. `bps` is an integer count, not money. */
function fpFromBps(value: FixedPointDecimal, bps: number): FixedPointDecimal {
  return FixedPointDecimal.fromStroops(
    (value.toStroops() * BigInt(bps)) / BPS_DENOMINATOR
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the strategy is configured with values it cannot simulate. */
export class DeltaNeutralConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeltaNeutralConfigError";
  }
}

/** Thrown when a lifecycle hook is called out of order. */
export class StrategyLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyLifecycleError";
  }
}

export function isDeltaNeutralConfigError(
  error: unknown
): error is DeltaNeutralConfigError {
  return error instanceof DeltaNeutralConfigError;
}

export function isStrategyLifecycleError(
  error: unknown
): error is StrategyLifecycleError {
  return error instanceof StrategyLifecycleError;
}

// ---------------------------------------------------------------------------
// Consumed models (#926 sizing, #927 funding/basis)
// ---------------------------------------------------------------------------

export interface PositionSizeParams {
  readonly capital: FixedPointDecimal;
  readonly targetLeverage: FixedPointDecimal;
  readonly prices: Record<string, FixedPointDecimal>;
}

export interface PositionSizeResult {
  readonly longNotional: FixedPointDecimal;
  readonly shortNotional: FixedPointDecimal;
  readonly marginPerLeg: FixedPointDecimal;
}

/**
 * Minimal structural surface of the delta-neutral position sizing model
 * (#926). `sizePosition` from that issue satisfies it as-is, so this strategy
 * can consume the real model by injection without importing a module that is
 * not on `main` yet.
 */
export interface PositionSizingModel {
  sizePosition(params: PositionSizeParams): PositionSizeResult;
}

export interface FundingCapture {
  readonly horizon: number;
  readonly funding: FixedPointDecimal;
  readonly basis: FixedPointDecimal;
}

/**
 * Minimal structural surface of the funding/basis term-structure model (#927);
 * `FundingTermStructure` from that issue satisfies it.
 */
export interface FundingBasisModel {
  getExpectedCapture(horizon: number): FundingCapture;
}

// ---------------------------------------------------------------------------
// Modeled hedge venue
// ---------------------------------------------------------------------------

/** A single modeled hedge-venue fill. There is no live venue in simulation. */
export interface HedgeFill {
  readonly tick: number;
  readonly price: FixedPointDecimal;
  /** Signed quote notional: positive increases the short, negative reduces it. */
  readonly deltaNotional: FixedPointDecimal;
  readonly shortNotionalAfter: FixedPointDecimal;
}

/**
 * The hedge leg of the book. The issue models the hedge rather than trading a
 * live perp venue, so `ModeledHedgeVenue` is a deterministic ledger: it tracks
 * the short quote notional and records every adjustment. No network, no clock,
 * no randomness.
 */
export interface HedgeVenue {
  readonly shortNotional: FixedPointDecimal;
  readonly fills: readonly HedgeFill[];
  openShort(
    notional: FixedPointDecimal,
    price: FixedPointDecimal,
    tick: number
  ): HedgeFill;
  adjustShort(
    deltaNotional: FixedPointDecimal,
    price: FixedPointDecimal,
    tick: number
  ): HedgeFill;
  closeShort(price: FixedPointDecimal, tick: number): HedgeFill;
}

export class ModeledHedgeVenue implements HedgeVenue {
  #shortNotional = ZERO;
  readonly #fills: HedgeFill[] = [];

  get shortNotional(): FixedPointDecimal {
    return this.#shortNotional;
  }

  get fills(): readonly HedgeFill[] {
    return [...this.#fills];
  }

  openShort(
    notional: FixedPointDecimal,
    price: FixedPointDecimal,
    tick: number
  ): HedgeFill {
    if (fpSign(this.#shortNotional) !== 0) {
      throw new StrategyLifecycleError(
        "ModeledHedgeVenue: a short hedge is already open"
      );
    }
    if (fpSign(notional) <= 0) {
      throw new DeltaNeutralConfigError(
        "ModeledHedgeVenue: short notional must be strictly positive"
      );
    }
    return this.#record(notional, price, tick, notional);
  }

  adjustShort(
    deltaNotional: FixedPointDecimal,
    price: FixedPointDecimal,
    tick: number
  ): HedgeFill {
    const next = fpAdd(this.#shortNotional, deltaNotional);
    if (fpSign(next) < 0) {
      throw new DeltaNeutralConfigError(
        "ModeledHedgeVenue: adjustment would drive the short below zero"
      );
    }
    return this.#record(deltaNotional, price, tick, next);
  }

  closeShort(price: FixedPointDecimal, tick: number): HedgeFill {
    const delta = fpSub(ZERO, this.#shortNotional);
    return this.#record(delta, price, tick, ZERO);
  }

  #record(
    deltaNotional: FixedPointDecimal,
    price: FixedPointDecimal,
    tick: number,
    shortNotionalAfter: FixedPointDecimal
  ): HedgeFill {
    if (fpSign(price) <= 0) {
      throw new RangeError("ModeledHedgeVenue: price must be positive");
    }
    const fill: HedgeFill = {
      tick,
      price,
      deltaNotional,
      shortNotionalAfter,
    };
    this.#fills.push(fill);
    this.#shortNotional = shortNotionalAfter;
    return fill;
  }
}

// ---------------------------------------------------------------------------
// Strategy configuration and observations
// ---------------------------------------------------------------------------

export interface DeltaNeutralConfig {
  /** Stable identifier recorded in the run report. */
  readonly id?: string;
  /** The base asset held long on spot. */
  readonly asset: AssetSymbol;
  /** Gross leverage per leg; consumed by the sizing model (#926). */
  readonly targetLeverage: FixedPointDecimal;
  /**
   * Rebalance threshold as integer basis points of the long notional. A drift
   * whose absolute quote value exceeds `longNotional × bps / 10_000` triggers
   * `rebalance`.
   */
  readonly rebalanceBandBps: number;
  /** Ticks over which the funding/basis model is sampled at close. */
  readonly horizonTicks: number;
  readonly priceFeed: PriceFeed;
  readonly positionSizer: PositionSizingModel;
  readonly fundingModel: FundingBasisModel;
  /** Defaults to a fresh `ModeledHedgeVenue`. */
  readonly hedgeVenue?: HedgeVenue;
}

/** Per-tick net-delta observation, recorded by `step`. */
export interface DeltaObservation {
  readonly tick: number;
  readonly timestamp: SimulationTimestamp;
  readonly price: FixedPointDecimal;
  /** Marked exposure before any rebalance, in base units. */
  readonly netDelta: FixedPointDecimal;
  /** Marked exposure before any rebalance, in quote notional. */
  readonly netDeltaNotional: FixedPointDecimal;
  readonly rebalanced: boolean;
}

/** Read-only state snapshot for assertions and run reports. */
export interface DeltaNeutralSnapshot {
  readonly id: string;
  readonly asset: AssetSymbol;
  readonly spotQuantity: FixedPointDecimal;
  readonly hedgeQuoteNotional: FixedPointDecimal;
  readonly netDelta: FixedPointDecimal;
  readonly netDeltaNotional: FixedPointDecimal;
  readonly pricePnl: FixedPointDecimal;
  readonly fundingPnl: FixedPointDecimal;
  readonly basisPnl: FixedPointDecimal;
  readonly totalPnl: FixedPointDecimal;
  readonly equity: FixedPointDecimal;
  readonly rebalanceCount: number;
  readonly ticks: number;
  readonly closed: boolean;
}

// ---------------------------------------------------------------------------
// DeltaNeutralStrategy
// ---------------------------------------------------------------------------

/**
 * Delta-neutral strategy core: a long spot position plus an offsetting short
 * hedge of equal entry notional, so net price exposure starts at zero and the
 * book captures funding and basis independently of direction.
 *
 * The hedge is modeled as a *short quote-notional* position (as a perp venue
 * would quote it), so as spot moves its base-equivalent size changes and the
 * book drifts. Net delta in base units is
 *
 *   netDelta = spotQuantity − hedgeQuoteNotional / spotPrice
 *
 * which is exactly zero at entry and drifts with price. `step` records that
 * exposure every tick and restores neutrality through `rebalance` when the
 * drift's quote value leaves the configured band. Funding accrues from the
 * injected funding/basis model; price PnL is marked each step and the round-trip
 * basis is realized at `close`.
 *
 * Simulation only: no network, no clock, no randomness. All money math is
 * bigint stroops surfaced as `FixedPointDecimal`.
 */
export class DeltaNeutralStrategy implements Strategy {
  readonly id: string;

  readonly #asset: AssetSymbol;
  readonly #targetLeverage: FixedPointDecimal;
  readonly #rebalanceBandBps: number;
  readonly #horizonTicks: number;
  readonly #priceFeed: PriceFeed;
  readonly #positionSizer: PositionSizingModel;
  readonly #fundingModel: FundingBasisModel;
  readonly #venue: HedgeVenue;

  #initialized = false;
  #closed = false;
  #capital = ZERO;
  #longNotional = ZERO;
  #spotQuantity = ZERO;
  #entryPrice = ZERO;
  #lastPrice = ZERO;
  #lastTimestamp: SimulationTimestamp = 0;
  #tickIndex = 0;
  #pricePnl = ZERO;
  #fundingPnl = ZERO;
  #basisPnl = ZERO;
  #rebalanceCount = 0;
  #netDelta = ZERO;
  #netDeltaNotional = ZERO;
  #prevCapture: FundingCapture = { horizon: 0, funding: ZERO, basis: ZERO };
  readonly #observations: DeltaObservation[] = [];

  constructor(config: DeltaNeutralConfig) {
    if (
      !Number.isInteger(config.rebalanceBandBps) ||
      config.rebalanceBandBps < 0
    ) {
      throw new DeltaNeutralConfigError(
        "rebalanceBandBps must be a non-negative integer"
      );
    }
    if (!Number.isInteger(config.horizonTicks) || config.horizonTicks <= 0) {
      throw new DeltaNeutralConfigError(
        "horizonTicks must be a positive integer"
      );
    }
    this.id = config.id ?? `${config.asset}-delta-neutral`;
    this.#asset = config.asset;
    this.#targetLeverage = config.targetLeverage;
    this.#rebalanceBandBps = config.rebalanceBandBps;
    this.#horizonTicks = config.horizonTicks;
    this.#priceFeed = config.priceFeed;
    this.#positionSizer = config.positionSizer;
    this.#fundingModel = config.fundingModel;
    this.#venue = config.hedgeVenue ?? new ModeledHedgeVenue();
  }

  // -- accessors -----------------------------------------------------------

  /** Current marked exposure in base units (`spot − hedge base equivalent`). */
  get netDelta(): FixedPointDecimal {
    return this.#netDelta;
  }

  /** Current marked exposure in quote notional (`netDelta × price`). */
  get netDeltaNotional(): FixedPointDecimal {
    return this.#netDeltaNotional;
  }

  /** Every per-tick exposure recorded by `step`, in tick order. */
  get deltaHistory(): readonly DeltaObservation[] {
    return [...this.#observations];
  }

  get spotQuantity(): FixedPointDecimal {
    return this.#spotQuantity;
  }

  /** Spot price at `init`; the notional-matching reference for the hedge. */
  get entryPrice(): FixedPointDecimal {
    return this.#entryPrice;
  }

  /** Timestamp of the most recent `init`, `step` or `close` mark. */
  get lastTimestamp(): SimulationTimestamp {
    return this.#lastTimestamp;
  }

  get hedgeQuoteNotional(): FixedPointDecimal {
    return this.#venue.shortNotional;
  }

  get pricePnl(): FixedPointDecimal {
    return this.#pricePnl;
  }

  get fundingPnl(): FixedPointDecimal {
    return this.#fundingPnl;
  }

  get basisPnl(): FixedPointDecimal {
    return this.#basisPnl;
  }

  get totalPnl(): FixedPointDecimal {
    return fpAdd(fpAdd(this.#pricePnl, this.#fundingPnl), this.#basisPnl);
  }

  get equity(): FixedPointDecimal {
    return fpAdd(this.#capital, this.totalPnl);
  }

  get rebalanceCount(): number {
    return this.#rebalanceCount;
  }

  get isOpen(): boolean {
    return this.#initialized && !this.#closed;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  snapshot(): DeltaNeutralSnapshot {
    return {
      id: this.id,
      asset: this.#asset,
      spotQuantity: this.#spotQuantity,
      hedgeQuoteNotional: this.#venue.shortNotional,
      netDelta: this.#netDelta,
      netDeltaNotional: this.#netDeltaNotional,
      pricePnl: this.#pricePnl,
      fundingPnl: this.#fundingPnl,
      basisPnl: this.#basisPnl,
      totalPnl: this.totalPnl,
      equity: this.equity,
      rebalanceCount: this.#rebalanceCount,
      ticks: this.#tickIndex,
      closed: this.#closed,
    };
  }

  // -- lifecycle -----------------------------------------------------------

  init(context: StrategyInitContext): readonly Order[] {
    if (this.#initialized) {
      throw new StrategyLifecycleError(
        `${this.id}: init has already been called`
      );
    }
    const capital = context.capital;
    if (fpSign(capital) <= 0) {
      throw new DeltaNeutralConfigError(
        "init capital must be strictly positive"
      );
    }

    const price = this.#spotPrice(context.timestamp);
    const sizing = this.#positionSizer.sizePosition({
      capital,
      targetLeverage: this.#targetLeverage,
      prices: { [this.#asset]: price },
    });
    if (fpSign(sizing.longNotional) <= 0 || fpSign(sizing.shortNotional) <= 0) {
      throw new DeltaNeutralConfigError(
        "position sizer returned a non-positive notional"
      );
    }
    if (!fpIsZero(fpSub(sizing.longNotional, sizing.shortNotional))) {
      throw new DeltaNeutralConfigError(
        "position sizer must return equal long and short notionals for a delta-neutral book"
      );
    }

    this.#capital = capital;
    this.#longNotional = sizing.longNotional;
    // Base-unit size of the long leg: quantity = notional / price.
    this.#spotQuantity = fpDiv(sizing.longNotional, price);
    this.#entryPrice = price;
    this.#lastPrice = price;
    this.#lastTimestamp = context.timestamp;
    this.#venue.openShort(sizing.shortNotional, price, 0);
    this.#initialized = true;
    this.#refreshDelta(price);
    this.#observations.push({
      tick: 0,
      timestamp: context.timestamp,
      price,
      netDelta: this.#netDelta,
      netDeltaNotional: this.#netDeltaNotional,
      rebalanced: false,
    });

    return [
      {
        book: "spot",
        asset: this.#asset,
        side: "buy",
        notional: sizing.longNotional,
        price,
      },
      {
        book: "hedge",
        asset: this.#asset,
        side: "sell",
        notional: sizing.shortNotional,
        price,
      },
    ];
  }

  step(context: StrategyContext): readonly Order[] {
    this.#assertOpen();
    const price = this.#spotPrice(context.timestamp);

    // Mark the book from the previous price to this one before doing anything
    // else, so drift PnL is attributed to the state that was actually exposed.
    this.#markToMarket(price);
    this.#tickIndex += 1;
    this.#accrueFunding(this.#tickIndex);
    this.#lastPrice = price;
    this.#lastTimestamp = context.timestamp;

    this.#refreshDelta(price);
    const driftDelta = this.#netDelta;
    const driftNotional = this.#netDeltaNotional;
    const rebalanced = fpAbs(driftNotional).compareTo(this.#band()) > 0;
    const orders: readonly Order[] = rebalanced ? this.rebalance(context) : [];

    this.#observations.push({
      tick: this.#tickIndex,
      timestamp: context.timestamp,
      price,
      netDelta: driftDelta,
      netDeltaNotional: driftNotional,
      rebalanced,
    });

    return orders;
  }

  rebalance(context: StrategyContext): readonly Order[] {
    this.#assertOpen();
    const price = this.#spotPrice(context.timestamp);
    // Restore neutrality: the short hedge must equal the spot leg's current
    // quote value, so the residual base exposure goes back to zero.
    const targetHedge = fpMul(this.#spotQuantity, price);
    const delta = fpSub(targetHedge, this.#venue.shortNotional);

    if (fpIsZero(delta)) {
      this.#refreshDelta(price);
      return [];
    }

    this.#venue.adjustShort(delta, price, this.#tickIndex);
    this.#rebalanceCount += 1;
    this.#refreshDelta(price);

    const side: OrderSide = fpSign(delta) > 0 ? "sell" : "buy";
    return [
      {
        book: "hedge",
        asset: this.#asset,
        side,
        notional: fpAbs(delta),
        price,
      },
    ];
  }

  close(context: StrategyContext): readonly Order[] {
    this.#assertOpen();
    const price = this.#spotPrice(context.timestamp);

    this.#markToMarket(price);
    // The basis is an entry/exit round-trip capture, so it is realized once the
    // book is unwound at the sampled horizon rather than dripped per tick.
    const capture = this.#fundingModel.getExpectedCapture(this.#horizonTicks);
    this.#basisPnl = fpAdd(this.#basisPnl, capture.basis);
    this.#lastPrice = price;
    this.#lastTimestamp = context.timestamp;

    const spotNotional = fpMul(this.#spotQuantity, price);
    const hedgeNotional = this.#venue.shortNotional;
    this.#venue.closeShort(price, this.#tickIndex);

    // The modeled book is flat once the unwind orders are expressed.
    this.#spotQuantity = ZERO;
    this.#closed = true;
    this.#refreshDelta(price);

    return [
      {
        book: "spot",
        asset: this.#asset,
        side: "sell",
        notional: spotNotional,
        price,
      },
      {
        book: "hedge",
        asset: this.#asset,
        side: "buy",
        notional: hedgeNotional,
        price,
      },
    ];
  }

  // -- internals -----------------------------------------------------------

  #spotPrice(timestamp: SimulationTimestamp): FixedPointDecimal {
    const price = this.#priceFeed.getSpotPrice(this.#asset, timestamp);
    if (fpSign(price) <= 0) {
      throw new DeltaNeutralConfigError(
        `spot price for ${this.#asset} must be strictly positive`
      );
    }
    return price;
  }

  #band(): FixedPointDecimal {
    return fpFromBps(this.#longNotional, this.#rebalanceBandBps);
  }

  #assertOpen(): void {
    if (!this.#initialized) {
      throw new StrategyLifecycleError(
        `${this.id}: init must be called before this hook`
      );
    }
    if (this.#closed) {
      throw new StrategyLifecycleError(
        `${this.id}: the book is already closed`
      );
    }
  }

  #refreshDelta(price: FixedPointDecimal): void {
    this.#netDelta = this.#computeNetDelta(price);
    this.#netDeltaNotional = fpMul(this.#netDelta, price);
  }

  #computeNetDelta(price: FixedPointDecimal): FixedPointDecimal {
    const hedgeBase = fpDiv(this.#venue.shortNotional, price);
    return fpSub(this.#spotQuantity, hedgeBase);
  }

  /**
   * Mark both legs from `#lastPrice` to `price`:
   *   spot PnL   = spotQuantity × (price − lastPrice)
   *   short PnL  = hedgeNotional × (lastPrice − price) / lastPrice
   * When the book is neutral (`lastPrice × spotQuantity == hedgeNotional`) the
   * two terms cancel exactly, which is the point of the structure.
   */
  #markToMarket(price: FixedPointDecimal): void {
    if (fpSign(this.#lastPrice) <= 0) return;
    const priceDelta = fpSub(price, this.#lastPrice);
    const spotPnl = fpMul(this.#spotQuantity, priceDelta);
    const hedgePnl = fpDiv(
      fpMul(this.#venue.shortNotional, fpSub(ZERO, priceDelta)),
      this.#lastPrice
    );
    this.#pricePnl = fpAdd(this.#pricePnl, fpAdd(spotPnl, hedgePnl));
  }

  #accrueFunding(horizon: number): void {
    const capture = this.#fundingModel.getExpectedCapture(horizon);
    const incremental = fpSub(capture.funding, this.#prevCapture.funding);
    this.#fundingPnl = fpAdd(this.#fundingPnl, incremental);
    this.#prevCapture = capture;
  }
}
