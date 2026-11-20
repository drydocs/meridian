import { accruePortfolioTick, createPortfolioState } from "../accrual";
import type {
  CashInterestAccrual,
  FundingAccrualPosition,
  PortfolioTransaction,
} from "../accrual";
import type { SimulationClock } from "../clock";
import type { CostSchedule } from "../costs";
import { ZERO_COSTS } from "../costs";
import { Portfolio } from "../portfolio";
import type { Position, PriceSet } from "../portfolio";
import { ZERO_SLIPPAGE_MODEL, applyOrderFill } from "../slippage-model";
import type { SlippageModel } from "../slippage-model";
import { StrategyLifecycle, reportedEquity } from "../strategy";
import type {
  EngineOrder,
  Order,
  Strategy,
  StrategyContext,
} from "../strategy";
import { FixedPointDecimal, UnknownAssetError } from "../types";
import type {
  AssetSymbol,
  FundingRate,
  PriceFeed,
  SimulationTimestamp,
} from "../types";
import { isVenueOrder } from "../venue";
import type { VenueId, VenuePosition, VenueYieldRate } from "../venue";

const ZERO = FixedPointDecimal.fromStroops(0n);

/** Per-fill execution cost, applied through the #879 fill model. */
export interface ExecutionConfig {
  /** Defaults to zero slippage. */
  readonly slippageModel?: SlippageModel;
  /** Defaults to zero costs. */
  readonly costSchedule?: CostSchedule;
}

/**
 * Carrying cost applied over the interval between two ticks, so a run prorates
 * to the clock step rather than to a tick count and two step sizes agree over
 * the same window. Both rates are per second and both are optional; an omitted
 * rate accrues nothing.
 */
export type { VenueYieldRate };

export interface AccrualConfig {
  /** Rate earned on idle cash. */
  readonly cashRatePerSecond?: FixedPointDecimal;
  /**
   * Annualized rate earned on idle cash (e.g. 0.0525 for 5.25% APY).
   * Accrues against a 365-day year to avoid fractional stroop truncation.
   */
  readonly cashRateAnnual?: FixedPointDecimal;
  /**
   * Funding on each open position's marked notional, signed per #864: a
   * positive rate is paid by longs and received by shorts.
   */
  readonly fundingRate?: FundingRate;
  /** Yield rates keyed by `VenueId` for capital deployed to simulated venues. */
  readonly venueRates?: Readonly<Record<VenueId, VenueYieldRate>>;
}

export interface BacktestConfig<
  TConfig = unknown,
  TOrder extends EngineOrder = EngineOrder,
> {
  /** Authoritative time source. Every tick it yields is visited, in order. */
  readonly clock: SimulationClock;
  /**
   * Traded assets. All of them are priced from `prices` on every tick and
   * handed to the strategy as market state.
   */
  readonly assets: readonly AssetSymbol[];
  readonly prices: PriceFeed;
  readonly strategy: Strategy<TConfig, TOrder>;
  readonly strategyConfig: TConfig;
  readonly initialCash: FixedPointDecimal;
  readonly execution?: ExecutionConfig;
  readonly accrual?: AccrualConfig;
  readonly observer?: BacktestObserver;
}

export interface VenueYieldAccrual {
  readonly type: "venue-yield";
  readonly venueId: VenueId;
  readonly asset: AssetSymbol;
  readonly memberId?: string;
  readonly amount: FixedPointDecimal;
}

export type BacktestAccrualTransaction =
  PortfolioTransaction | VenueYieldAccrual;

/** Actual runner events exposed to specialized reporting such as composition attribution. */
export interface BacktestObserver {
  readonly onAccrual?: (event: {
    readonly timestamp: SimulationTimestamp;
    readonly cashBefore: FixedPointDecimal;
    readonly transactions: readonly BacktestAccrualTransaction[];
  }) => void;
  readonly onFill?: (fill: {
    readonly asset: AssetSymbol;
    readonly memberId?: string;
    readonly size: FixedPointDecimal;
    readonly price: FixedPointDecimal;
    readonly fee: FixedPointDecimal;
  }) => void;
  readonly onSnapshot?: (snapshot: BacktestSnapshot, prices: PriceSet) => void;
  readonly onFinal?: (state: {
    readonly positions: readonly Position[];
    readonly venues?: readonly VenuePosition[];
    readonly prices: PriceSet;
  }) => void;
}

/** State recorded at the end of one tick, after that tick's fills. */
export interface BacktestSnapshot {
  readonly index: number;
  readonly timestamp: SimulationTimestamp;
  readonly cash: FixedPointDecimal;
  readonly positions: readonly Position[];
  readonly venues?: readonly VenuePosition[];
  readonly value: FixedPointDecimal;
}

export interface BacktestResult {
  readonly strategyName: string;
  readonly initialCash: FixedPointDecimal;
  readonly snapshots: readonly BacktestSnapshot[];
  /** Portfolio value after the closing orders have been filled. */
  readonly finalValue: FixedPointDecimal;
  /**
   * The strategy's own book equity at close — the sum of every position it
   * tracks, including any modeled outside the runner's `Portfolio`.
   *
   * Equals `finalValue` for strategies that only trade through the runner's
   * `Portfolio`. Diverges for strategies that use modeled venues (e.g.
   * delta-neutral's `ModeledHedgeVenue`, whose short position lives outside
   * the portfolio — see #1047).
   *
   * Prefer this field when measuring a strategy's actual PnL. `finalValue`
   * reflects only the positions the runner's portfolio tracks.
   */
  readonly strategyEquity: FixedPointDecimal;
  readonly totalInterest: FixedPointDecimal;
  readonly totalFunding: FixedPointDecimal;
  readonly totalFees: FixedPointDecimal;
}

/**
 * Runs one fully deterministic backtest of a single strategy.
 *
 * Every tick applies the same order of operations, and that order is part of
 * the result rather than an implementation detail:
 *
 *   1. accrual  - funding on each open position, then interest on idle cash,
 *                 both over the interval since the previous tick and both
 *                 marked at this tick's prices;
 *   2. strategy - `step`, then `rebalance`, driven through `StrategyLifecycle`
 *                 so the lifecycle order is enforced rather than assumed;
 *   3. execution - spot orders are priced by `applyOrderFill` (slippage first,
 *                  then costs); venue orders update the venue ledger. Both are
 *                  applied in the order returned;
 *   4. snapshot  - cash, spot positions, venue positions and marked value are
 *                  recorded.
 *
 * The first tick has no preceding interval and so accrues nothing.
 *
 * After the final tick, `close` is called once and its orders are executed the
 * same way. Any positions or venue balances left open remain in `finalValue`.
 */
export function runBacktest<
  TConfig = unknown,
  TOrder extends EngineOrder = EngineOrder,
>(config: BacktestConfig<TConfig, TOrder>): BacktestResult {
  const { clock, prices: priceFeed } = config;
  const lifecycle = new StrategyLifecycle(config.strategy);
  lifecycle.init({
    startingCapital: config.initialCash,
    config: config.strategyConfig,
  });

  const portfolio = new Portfolio(config.initialCash);
  const snapshots: BacktestSnapshot[] = [];
  const execution = config.execution ?? {};
  // Fractional-stroop remainders carried between ticks for every accrual path.
  let remainders: Readonly<Record<string, bigint>> = {};
  let totalInterest = ZERO;
  let totalFunding = ZERO;
  let previous: SimulationTimestamp | null = null;
  let index = 0;

  for (const timestamp of clock.ticks()) {
    const market = marketAt(priceFeed, config.assets, timestamp);

    if (previous !== null) {
      const elapsed = timestamp - previous;

      // Funding and cash interest both go through the accrual engine so
      // fractional-stroop accrual carries between ticks instead of being
      // truncated away. The engine hands that carry back inside a
      // `PortfolioState`, and the runner keeps only the remainders, because
      // `Portfolio` owns cash and positions.
      const accrued = accruePortfolioTick(
        {
          ...createPortfolioState(portfolio.cash),
          accrualRemainders: remainders,
        },
        {
          elapsedMilliseconds: elapsed,
          borrowPositions: [],
          fundingPositions: fundingPositions(portfolio, market, config.accrual),
          cashInterest: cashInterest(config.accrual),
        }
      );
      remainders = {
        ...Object.fromEntries(
          Object.entries(remainders).filter(([key]) => key.startsWith("venue:"))
        ),
        ...accrued.portfolio.accrualRemainders,
      };
      let funding = ZERO;
      let interest = ZERO;
      for (const transaction of accrued.transactions) {
        if (transaction.type === "funding-payment") {
          funding = funding.add(transaction.amount);
        } else if (transaction.type === "cash-interest") {
          interest = interest.add(transaction.amount);
        }
      }

      totalFunding = totalFunding.add(funding);
      const cashBefore = portfolio.cash;

      const venuesBefore = new Map(
        portfolio
          .venues()
          .map((venue) => [
            JSON.stringify([
              venue.memberId ?? null,
              venue.venueId,
              venue.asset,
            ]),
            venue,
          ])
      );
      remainders = portfolio.venueLedger.accrueTick(
        elapsed,
        config.accrual?.venueRates,
        remainders
      );

      const transactions: BacktestAccrualTransaction[] = [
        ...accrued.transactions,
      ];
      let venueInterest = ZERO;
      for (const venue of portfolio.venues()) {
        const key = JSON.stringify([
          venue.memberId ?? null,
          venue.venueId,
          venue.asset,
        ]);
        const previousYield = venuesBefore.get(key)?.accruedYield ?? ZERO;
        const amount = venue.accruedYield.sub(previousYield);
        if (amount.toStroops() <= 0n) continue;

        const price = market.prices.get(venue.asset);
        if (price === undefined) throw new UnknownAssetError(venue.asset);
        venueInterest = venueInterest.add(amount.mul(price));
        transactions.push({
          type: "venue-yield",
          venueId: venue.venueId,
          asset: venue.asset,
          ...(venue.memberId === undefined ? {} : { memberId: venue.memberId }),
          amount,
        });
      }
      totalInterest = totalInterest.add(interest).add(venueInterest);
      config.observer?.onAccrual?.({
        timestamp,
        cashBefore,
        transactions,
      });
      portfolio.applyCashFlow(funding.add(interest));
    }

    const context: StrategyContext = { market, portfolio, venues: portfolio };
    lifecycle.step(context);

    for (const order of lifecycle.rebalance(context)) {
      executeOrder(portfolio, order, market.prices, execution, config.observer);
    }

    snapshots.push({
      index,
      timestamp,
      cash: portfolio.cash,
      positions: portfolio.positions(),
      venues: portfolio.venues(),
      value: portfolio.totalValue(market.prices),
    });
    config.observer?.onSnapshot?.(
      snapshots[snapshots.length - 1]!,
      market.prices
    );

    previous = timestamp;
    index += 1;
  }

  // `clock.end` is the final tick, so closing orders are priced at the same
  // mark the last snapshot was taken at.
  const closing: StrategyContext = {
    market: marketAt(priceFeed, config.assets, clock.end),
    portfolio,
    venues: portfolio,
  };
  for (const order of lifecycle.close(closing)) {
    executeOrder(
      portfolio,
      order,
      closing.market.prices,
      execution,
      config.observer
    );
  }

  // Strategies that self-report equity (e.g. delta-neutral with a modeled
  // hedge venue) surface their own book value; the rest fall back to the
  // portfolio's value, which is correct for pure-portfolio strategies.
  const portfolioValue = portfolio.totalValue(closing.market.prices);
  config.observer?.onFinal?.({
    positions: portfolio.positions(),
    venues: portfolio.venues(),
    prices: closing.market.prices,
  });
  const selfEquity = reportedEquity(config.strategy);
  const strategyEquity = selfEquity ?? portfolioValue;

  return {
    strategyName: config.strategy.name,
    initialCash: config.initialCash,
    snapshots,
    finalValue: portfolioValue,
    strategyEquity,
    totalInterest,
    totalFunding,
    totalFees: portfolio.fees,
  };
}

/** Canonical, byte-stable JSON for a snapshot sequence. */
export function serializeSnapshots(
  snapshots: readonly BacktestSnapshot[]
): string {
  return JSON.stringify(
    snapshots.map((snapshot) => ({
      index: snapshot.index,
      timestamp: snapshot.timestamp,
      cash: snapshot.cash.toString(),
      positions: snapshot.positions.map((position) => ({
        asset: position.asset,
        size: position.size.toString(),
        basis: position.basis.toString(),
      })),
      ...(snapshot.venues && snapshot.venues.length > 0
        ? {
            venues: snapshot.venues.map((venue) => ({
              venueId: venue.venueId,
              asset: venue.asset,
              ...(venue.memberId === undefined
                ? {}
                : { memberId: venue.memberId }),
              deployedPrincipal: venue.deployedPrincipal.toString(),
              accruedYield: venue.accruedYield.toString(),
            })),
          }
        : {}),
      value: snapshot.value.toString(),
    }))
  );
}

/** Prices every configured asset at one instant. */
function marketAt(
  priceFeed: PriceFeed,
  assets: readonly AssetSymbol[],
  timestamp: SimulationTimestamp
): StrategyContext["market"] {
  const prices = new Map<AssetSymbol, FixedPointDecimal>();
  for (const asset of assets) {
    prices.set(asset, priceFeed.getSpotPrice(asset, timestamp));
  }
  return { timestamp, prices };
}

/** One funding entry per open position, at its marked notional. */
function fundingPositions(
  portfolio: Portfolio,
  market: StrategyContext["market"],
  accrual: AccrualConfig | undefined
): FundingAccrualPosition[] {
  const rate = accrual?.fundingRate;
  if (rate === undefined) return [];
  // The configured rate is the market's, which longs pay when it is positive,
  // while the accrual engine reads each rate from the position's own side.
  const longRate: FundingRate = { ratePerSecond: ZERO.sub(rate.ratePerSecond) };

  const positions: FundingAccrualPosition[] = [];
  for (const position of portfolio.positions()) {
    const price = market.prices.get(position.asset);
    if (price === undefined) {
      throw new RangeError(
        `runBacktest: no price for "${position.asset}" to accrue funding on`
      );
    }
    const stroops = position.size.toStroops();
    const size = FixedPointDecimal.fromStroops(abs(stroops)).mul(price);
    positions.push({
      id:
        position.memberId === undefined
          ? position.asset
          : `${position.memberId}:${position.asset}`,
      ...(position.memberId === undefined
        ? {}
        : { memberId: position.memberId }),
      notional: size,
      rate: stroops > 0n ? longRate : rate,
    });
  }
  return positions;
}

/** The configured cash rate, or nothing when the run earns none. */
function cashInterest(
  accrual: AccrualConfig | undefined
): CashInterestAccrual | undefined {
  if (accrual === undefined) return undefined;
  if (accrual.cashRateAnnual !== undefined) {
    return { annualRate: accrual.cashRateAnnual };
  }
  const rate = accrual.cashRatePerSecond;
  if (rate === undefined) return undefined;
  return { ratePerSecond: rate };
}

function executeOrder(
  portfolio: Portfolio,
  order: EngineOrder,
  prices: PriceSet,
  execution: ExecutionConfig,
  observer?: BacktestObserver
): void {
  if (isVenueOrder(order)) {
    if (!prices.has(order.asset)) {
      throw new RangeError(`runBacktest: no price for "${order.asset}"`);
    }
    portfolio.applyVenueOrder(
      order,
      prices,
      (execution.costSchedule ?? ZERO_COSTS).networkFee
    );
    return;
  }
  fill(portfolio, order, prices, execution, observer);
}

/** Prices one order through the fill model and applies it to the portfolio. */
function fill(
  portfolio: Portfolio,
  order: Order,
  prices: PriceSet,
  execution: ExecutionConfig,
  observer?: BacktestObserver
): void {
  const midPrice = prices.get(order.asset);
  if (midPrice === undefined) {
    throw new RangeError(`runBacktest: no price for "${order.asset}"`);
  }

  const signed = order.size.toStroops();
  const adjusted = applyOrderFill({
    side: signed < 0n ? "sell" : "buy",
    quantity: FixedPointDecimal.fromStroops(abs(signed)),
    midPrice,
    slippageModel: execution.slippageModel ?? ZERO_SLIPPAGE_MODEL,
    costSchedule: execution.costSchedule ?? ZERO_COSTS,
  });

  const appliedFill = {
    asset: order.asset,
    ...(order.memberId === undefined ? {} : { memberId: order.memberId }),
    size: order.size,
    price: adjusted.effectivePrice,
    fee: adjusted.totalCost,
  };
  portfolio.applyFill(appliedFill);
  observer?.onFill?.(appliedFill);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
