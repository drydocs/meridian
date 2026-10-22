import { accruePortfolioTick, createPortfolioState } from "../accrual";
import type { CashInterestAccrual, FundingAccrualPosition } from "../accrual";
import type { SimulationClock } from "../clock";
import type { CostSchedule } from "../costs";
import { ZERO_COSTS } from "../costs";
import { Portfolio } from "../portfolio";
import type { Position, PriceSet } from "../portfolio";
import { ZERO_SLIPPAGE_MODEL, applyOrderFill } from "../slippage-model";
import type { SlippageModel } from "../slippage-model";
import { StrategyLifecycle, reportedEquity } from "../strategy";
import type { Order, Strategy, StrategyContext } from "../strategy";
import { FixedPointDecimal } from "../types";
import type {
  AssetSymbol,
  FundingRate,
  PriceFeed,
  SimulationTimestamp,
} from "../types";

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
export interface AccrualConfig {
  /** Rate earned on idle cash. */
  readonly cashRatePerSecond?: FixedPointDecimal;
  /**
   * Funding on each open position's marked notional, signed per #864: a
   * positive rate is paid by longs and received by shorts.
   */
  readonly fundingRate?: FundingRate;
}

export interface BacktestConfig<TConfig = unknown> {
  /** Authoritative time source. Every tick it yields is visited, in order. */
  readonly clock: SimulationClock;
  /**
   * Traded assets. All of them are priced from `prices` on every tick and
   * handed to the strategy as market state.
   */
  readonly assets: readonly AssetSymbol[];
  readonly prices: PriceFeed;
  readonly strategy: Strategy<TConfig>;
  readonly strategyConfig: TConfig;
  readonly initialCash: FixedPointDecimal;
  readonly execution?: ExecutionConfig;
  readonly accrual?: AccrualConfig;
}

/** State recorded at the end of one tick, after that tick's fills. */
export interface BacktestSnapshot {
  readonly index: number;
  readonly timestamp: SimulationTimestamp;
  readonly cash: FixedPointDecimal;
  readonly positions: readonly Position[];
  readonly value: FixedPointDecimal;
}

export interface BacktestResult {
  readonly strategyName: string;
  readonly initialCash: FixedPointDecimal;
  readonly snapshots: readonly BacktestSnapshot[];
  /** Value after the closing orders have been filled, so positions are shut. */
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
 *   3. fills    - each returned order is priced by `applyOrderFill` (slippage
 *                 first, then costs) and applied in the order it was returned;
 *   4. snapshot - cash, positions and marked value are recorded.
 *
 * The first tick has no preceding interval and so accrues nothing.
 *
 * After the final tick, `close` is called once and its orders are filled the
 * same way, which is what leaves `finalValue` in cash.
 */
export function runBacktest<TConfig = unknown>(
  config: BacktestConfig<TConfig>
): BacktestResult {
  const { clock, prices: priceFeed } = config;
  const lifecycle = new StrategyLifecycle(config.strategy);
  lifecycle.init({
    startingCapital: config.initialCash,
    config: config.strategyConfig,
  });

  const portfolio = new Portfolio(config.initialCash);
  const snapshots: BacktestSnapshot[] = [];
  const execution = config.execution ?? {};
  // Fractional-stroop remainders carried between ticks, keyed `funding:<id>`
  // or `cash`, exactly as the accrual engine keys them.
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
      remainders = accrued.portfolio.accrualRemainders;

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
      totalInterest = totalInterest.add(interest);
      portfolio.applyCashFlow(funding.add(interest));
    }

    const context: StrategyContext = { market, portfolio };
    lifecycle.step(context);

    for (const order of lifecycle.rebalance(context)) {
      fill(portfolio, order, market.prices, execution);
    }

    snapshots.push({
      index,
      timestamp,
      cash: portfolio.cash,
      positions: portfolio.positions(),
      value: portfolio.totalValue(market.prices),
    });

    previous = timestamp;
    index += 1;
  }

  // `clock.end` is the final tick, so closing orders are priced at the same
  // mark the last snapshot was taken at.
  const closing: StrategyContext = {
    market: marketAt(priceFeed, config.assets, clock.end),
    portfolio,
  };
  for (const order of lifecycle.close(closing)) {
    fill(portfolio, order, closing.market.prices, execution);
  }

  // Strategies that self-report equity (e.g. delta-neutral with a modeled
  // hedge venue) surface their own book value; the rest fall back to the
  // portfolio's value, which is correct for pure-portfolio strategies.
  const portfolioValue = portfolio.totalValue(closing.market.prices);
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
  const rate = accrual?.cashRatePerSecond;
  if (rate === undefined) return undefined;
  return { ratePerSecond: rate };
}

/** Prices one order through the fill model and applies it to the portfolio. */
function fill(
  portfolio: Portfolio,
  order: Order,
  prices: PriceSet,
  execution: ExecutionConfig
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

  portfolio.applyFill({
    asset: order.asset,
    memberId: order.memberId,
    size: order.size,
    price: adjusted.effectivePrice,
    fee: adjusted.totalCost,
  });
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
