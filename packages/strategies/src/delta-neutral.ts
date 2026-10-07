import { FixedPointDecimal } from "./types";
import type {
  AssetSymbol,
  FundingRate,
  PriceFeed,
  SimulationTimestamp,
} from "./types";
import { accrueFunding, computeBasis } from "./funding";
import { sizePosition } from "./sizing";
import { LifecycleOrderError } from "./strategy";
import type {
  Order,
  Strategy,
  StrategyContext,
  StrategyInitParams,
} from "./strategy";

// ---------------------------------------------------------------------------
// Fixed-point helpers
// ---------------------------------------------------------------------------
//
// `FixedPointDecimal` exposes construction and comparison but no arithmetic, so
// the delta-neutral core does its bigint-stroop math here and hands every value
// back as a `FixedPointDecimal`. Nothing in this module ever touches an
// IEEE-754 float for money: the only `number` values are integer tick indices,
// timestamps and basis-point counts.

const STROOPS_PER_UNIT = 10_000_000n;
const BPS_DENOMINATOR = 10_000n;
const MILLIS_PER_SECOND = 1000;

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

export function isDeltaNeutralConfigError(
  error: unknown
): error is DeltaNeutralConfigError {
  return error instanceof DeltaNeutralConfigError;
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
      throw new LifecycleOrderError(
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
  /** Stable identifier recorded in the run snapshot. */
  readonly id?: string;
  /** The base asset held long on spot. */
  readonly asset: AssetSymbol;
  /** Gross leverage per leg; consumed by `sizePosition` (#926). */
  readonly targetLeverage: FixedPointDecimal;
  /**
   * Rebalance threshold in integer basis points of the book's total equity. A
   * drift whose absolute quote value exceeds `equity × bps / 10_000` triggers
   * `rebalance`.
   */
  readonly rebalanceBandBps: number;
  /** Per-second funding rate applied to the short hedge (#927). */
  readonly fundingRate: FundingRate;
  /** Spot marks for the long leg and for the hedge venue. */
  readonly priceFeed: PriceFeed;
  /**
   * Perp marks for the hedge. Defaults to `priceFeed`, which models a perp
   * trading at spot and so realizes no basis.
   */
  readonly hedgeFeed?: PriceFeed;
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
  readonly entered: boolean;
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
 * configured rate; price PnL is marked each step and the round-trip basis is
 * realized at `close`.
 *
 * Simulation only: no network, no clock, no randomness. All money math is
 * bigint stroops surfaced as `FixedPointDecimal`.
 */
export class DeltaNeutralStrategy implements Strategy<DeltaNeutralConfig> {
  readonly name = "delta-neutral";

  #config: DeltaNeutralConfig | null = null;
  #venue: HedgeVenue | null = null;

  #initialized = false;
  #entered = false;
  #closed = false;
  #longMargin = ZERO;
  #shortMargin = ZERO;
  #spotQuantity = ZERO;
  #entryPrice = ZERO;
  #entryHedgePrice = ZERO;
  #lastPrice = ZERO;
  #lastTimestamp: SimulationTimestamp = 0;
  #tickIndex = 0;
  #pricePnl = ZERO;
  #fundingPnl = ZERO;
  #basisPnl = ZERO;
  #rebalanceCount = 0;
  #netDelta = ZERO;
  #netDeltaNotional = ZERO;
  readonly #observations: DeltaObservation[] = [];

  get id(): string {
    const config = this.#requireConfig();
    return config.id ?? `${config.asset}-delta-neutral`;
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

  /** Every per-tick exposure recorded by the lifecycle, in tick order. */
  get deltaHistory(): readonly DeltaObservation[] {
    return [...this.#observations];
  }

  get spotQuantity(): FixedPointDecimal {
    return this.#spotQuantity;
  }

  /** Spot price at entry; the notional-matching reference for the hedge. */
  get entryPrice(): FixedPointDecimal {
    return this.#entryPrice;
  }

  /** Timestamp of the most recent entry, step or close mark. */
  get lastTimestamp(): SimulationTimestamp {
    return this.#lastTimestamp;
  }

  get hedgeQuoteNotional(): FixedPointDecimal {
    return this.#venue ? this.#venue.shortNotional : ZERO;
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

  /**
   * Both legs post their margin, so the book's equity is the two margins plus
   * PnL rather than the starting capital alone.
   */
  get equity(): FixedPointDecimal {
    return fpAdd(fpAdd(this.#longMargin, this.#shortMargin), this.totalPnl);
  }

  get rebalanceCount(): number {
    return this.#rebalanceCount;
  }

  get isOpen(): boolean {
    return this.#entered && !this.#closed;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  snapshot(): DeltaNeutralSnapshot {
    return {
      id: this.id,
      asset: this.#requireConfig().asset,
      entered: this.#entered,
      spotQuantity: this.#spotQuantity,
      hedgeQuoteNotional: this.hedgeQuoteNotional,
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

  /**
   * Records the configuration only. Entry is expressed as an order from the
   * first `rebalance` because that is the hook the runner reads orders from,
   * so the spot leg and the modeled hedge open together on the first tick.
   */
  init(params: StrategyInitParams<DeltaNeutralConfig>): void {
    if (this.#initialized) {
      throw new LifecycleOrderError(
        `${this.name}: init has already been called`
      );
    }
    const config = params.config;
    if (
      !Number.isInteger(config.rebalanceBandBps) ||
      config.rebalanceBandBps < 0
    ) {
      throw new DeltaNeutralConfigError(
        "rebalanceBandBps must be a non-negative integer"
      );
    }
    if (fpSign(params.startingCapital) <= 0) {
      throw new DeltaNeutralConfigError(
        "starting capital must be strictly positive"
      );
    }

    this.#config = config;
    this.#venue = config.hedgeVenue ?? new ModeledHedgeVenue();
    this.#longMargin = params.startingCapital;
    this.#shortMargin = params.startingCapital;
    this.#initialized = true;
  }

  step(context: StrategyContext): void {
    this.#assertOpen();
    if (!this.#entered) return;

    const price = this.#spotPrice(context.market.timestamp);
    // Mark the book from the previous price to this one before anything else,
    // so drift PnL is attributed to the state that was actually exposed.
    this.#markToMarket(price);
    this.#accrueFunding(context.market.timestamp);
    this.#tickIndex += 1;
    this.#lastPrice = price;
    this.#lastTimestamp = context.market.timestamp;

    this.#refreshDelta(price);
    this.#observations.push({
      tick: this.#tickIndex,
      timestamp: context.market.timestamp,
      price,
      netDelta: this.#netDelta,
      netDeltaNotional: this.#netDeltaNotional,
      rebalanced: false,
    });
  }

  rebalance(context: StrategyContext): readonly Order[] {
    this.#assertOpen();
    const price = this.#spotPrice(context.market.timestamp);

    if (!this.#entered) return this.#enter(context, price);
    if (fpAbs(this.#netDeltaNotional).compareTo(this.#band()) <= 0) return [];

    // Restore neutrality: the short hedge must equal the spot leg's current
    // quote value, so the residual base exposure goes back to zero. The hedge
    // exists only in the modeled venue, which the runner cannot fill, so this
    // produces no order. Returning one for the same adjustment would count the
    // rebalance twice.
    const targetHedge = fpMul(this.#spotQuantity, price);
    const delta = fpSub(targetHedge, this.#venueOf().shortNotional);
    if (!fpIsZero(delta)) {
      this.#venueOf().adjustShort(
        delta,
        this.#hedgePrice(context.market.timestamp),
        this.#tickIndex
      );
      this.#rebalanceCount += 1;
      this.#refreshDelta(price);
    }
    this.#markLastObservationRebalanced();
    return [];
  }

  close(context: StrategyContext): readonly Order[] {
    this.#assertOpen();
    const config = this.#requireConfig();
    if (!this.#entered) {
      this.#closed = true;
      return [];
    }

    const timestamp = context.market.timestamp;
    const price = this.#spotPrice(timestamp);
    const hedgePrice = this.#hedgePrice(timestamp);

    this.#markToMarket(price);
    // The venue marks the hedge at spot, so the perp's own basis never reaches
    // the price PnL. `quantity × Δbasis` is that correction, and for a
    // base-matched hedge it is exactly the basis the round trip captured.
    const basisDrift = fpSub(
      computeBasis(price, hedgePrice),
      computeBasis(this.#entryPrice, this.#entryHedgePrice)
    );
    this.#basisPnl = fpAdd(
      this.#basisPnl,
      fpMul(this.#spotQuantity, basisDrift)
    );
    this.#lastPrice = price;
    this.#lastTimestamp = timestamp;

    const exitQuantity = this.#spotQuantity;
    this.#venueOf().closeShort(hedgePrice, this.#tickIndex);

    // The modeled book is flat once the unwind order is expressed.
    this.#spotQuantity = ZERO;
    this.#closed = true;
    this.#refreshDelta(price);
    return [
      {
        asset: config.asset,
        size: FixedPointDecimal.fromStroops(-exitQuantity.toStroops()),
        reason: "unwind at run end",
      },
    ];
  }

  // -- internals -----------------------------------------------------------

  #enter(context: StrategyContext, price: FixedPointDecimal): readonly Order[] {
    const config = this.#requireConfig();
    const timestamp = context.market.timestamp;
    const hedgePrice = this.#hedgePrice(timestamp);
    const sizing = sizePosition({
      capital: this.#longMargin,
      targetLeverage: config.targetLeverage,
      prices: { long: price, short: hedgePrice },
    });

    // `sizePosition` splits the notional 1:1 across the legs and rejects
    // non-positive capital, out-of-range leverage and non-positive prices, so
    // the book is neutral at entry without a second round of validation here.
    this.#longMargin = sizing.longMargin;
    this.#shortMargin = sizing.shortMargin;
    this.#spotQuantity = fpDiv(sizing.longNotional, price);
    this.#entryPrice = price;
    this.#entryHedgePrice = hedgePrice;
    this.#lastPrice = price;
    this.#lastTimestamp = timestamp;
    this.#venueOf().openShort(
      sizing.shortNotional,
      hedgePrice,
      this.#tickIndex
    );
    this.#entered = true;
    this.#refreshDelta(price);
    this.#observations.push({
      tick: this.#tickIndex,
      timestamp,
      price,
      netDelta: this.#netDelta,
      netDeltaNotional: this.#netDeltaNotional,
      rebalanced: false,
    });

    return [
      {
        asset: config.asset,
        size: this.#spotQuantity,
        reason: "open the spot leg",
      },
    ];
  }

  #band(): FixedPointDecimal {
    return fpFromBps(this.equity, this.#requireConfig().rebalanceBandBps);
  }

  #markLastObservationRebalanced(): void {
    const index = this.#observations.length - 1;
    const last = this.#observations[index];
    if (last) this.#observations[index] = { ...last, rebalanced: true };
  }

  #requireConfig(): DeltaNeutralConfig {
    if (!this.#config) {
      throw new LifecycleOrderError(`${this.name}: init must be called first`);
    }
    return this.#config;
  }

  #venueOf(): HedgeVenue {
    if (!this.#venue) {
      throw new LifecycleOrderError(`${this.name}: init must be called first`);
    }
    return this.#venue;
  }

  #venueNotional(): FixedPointDecimal {
    return this.#venueOf().shortNotional;
  }

  #assertOpen(): void {
    if (!this.#initialized) {
      throw new LifecycleOrderError(`${this.name}: init must be called first`);
    }
    if (this.#closed) {
      throw new LifecycleOrderError(`${this.name}: the book is already closed`);
    }
  }

  #spotPrice(timestamp: SimulationTimestamp): FixedPointDecimal {
    const config = this.#requireConfig();
    return this.#positivePrice(
      config.priceFeed.getSpotPrice(config.asset, timestamp),
      "spot price"
    );
  }

  #hedgePrice(timestamp: SimulationTimestamp): FixedPointDecimal {
    const config = this.#requireConfig();
    const feed = config.hedgeFeed ?? config.priceFeed;
    return this.#positivePrice(
      feed.getSpotPrice(config.asset, timestamp),
      "hedge price"
    );
  }

  #positivePrice(price: FixedPointDecimal, label: string): FixedPointDecimal {
    if (fpSign(price) <= 0) {
      throw new DeltaNeutralConfigError(
        `${label} for ${this.#requireConfig().asset} must be strictly positive`
      );
    }
    return price;
  }

  #refreshDelta(price: FixedPointDecimal): void {
    this.#netDelta = this.#computeNetDelta(price);
    this.#netDeltaNotional = fpMul(this.#netDelta, price);
  }

  #computeNetDelta(price: FixedPointDecimal): FixedPointDecimal {
    const hedgeBase = fpDiv(this.#venueNotional(), price);
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
      fpMul(this.#venueNotional(), fpSub(ZERO, priceDelta)),
      this.#lastPrice
    );
    this.#pricePnl = fpAdd(this.#pricePnl, fpAdd(spotPnl, hedgePnl));
  }

  #accrueFunding(timestamp: SimulationTimestamp): void {
    const elapsed = timestamp - this.#lastTimestamp;
    if (elapsed <= 0) return;
    const seconds = BigInt(Math.floor(elapsed / MILLIS_PER_SECOND));
    if (seconds === 0n) return;
    this.#fundingPnl = fpAdd(
      this.#fundingPnl,
      accrueFunding(
        { notional: this.#venueNotional() },
        this.#requireConfig().fundingRate,
        seconds
      )
    );
  }
}
