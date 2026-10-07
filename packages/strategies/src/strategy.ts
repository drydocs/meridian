import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";
import type { AssetSymbol, SimulationTimestamp } from "./types";

/** Read-only view of one open position. */
export interface PositionView {
  readonly asset: AssetSymbol;
  /** Signed size: positive long, negative short. */
  readonly size: FixedPointDecimal;
  readonly basis: FixedPointDecimal;
}

/**
 * Read-only view of portfolio state handed to strategies. It intentionally
 * has no mutating methods: strategies express intent through returned
 * orders and the runner applies fills. The runner's `Portfolio` satisfies
 * this structurally.
 */
export interface PortfolioView {
  readonly cash: FixedPointDecimal;
  getPosition(asset: AssetSymbol): PositionView | undefined;
  positions(): readonly PositionView[];
  totalValue(
    prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>
  ): FixedPointDecimal;
}

/** Market data visible at one simulated tick. */
export interface MarketState {
  readonly timestamp: SimulationTimestamp;
  readonly prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>;
}

/** Intended trade. Positive size buys, negative sells. */
export interface Order {
  readonly asset: AssetSymbol;
  readonly size: FixedPointDecimal;
  readonly reason?: string;
}

export interface StrategyInitParams<TConfig> {
  readonly startingCapital: FixedPointDecimal;
  readonly config: TConfig;
}

export interface StrategyContext {
  readonly market: MarketState;
  readonly portfolio: PortfolioView;
}

/**
 * Contract every strategy implements so one runner can drive any of them.
 *
 * Lifecycle, enforced by `StrategyLifecycle`:
 *   1. `init` exactly once, before anything else.
 *   2. For every clock tick, in order: `step`, then `rebalance`.
 *      Timestamps strictly increase between ticks.
 *   3. `close` exactly once at run end; nothing may follow it.
 *
 * `step` observes (update internal state, accrue bookkeeping) and returns
 * nothing. `rebalance` and `close` return intended orders. Strategies never
 * mutate portfolio state directly; the runner applies the orders as fills.
 */
export interface Strategy<TConfig = unknown> {
  readonly name: string;
  init(params: StrategyInitParams<TConfig>): void;
  step(context: StrategyContext): void;
  rebalance(context: StrategyContext): readonly Order[];
  close(context: StrategyContext): readonly Order[];
}

export class LifecycleOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleOrderError";
  }
}

type Phase = "new" | "ready" | "stepped" | "rebalanced" | "closed";

/**
 * Wraps a strategy and rejects out-of-order calls. A runner drives the
 * strategy only through this guard, which makes the lifecycle a checked
 * contract rather than a convention.
 */
export class StrategyLifecycle<TConfig = unknown> {
  readonly strategy: Strategy<TConfig>;
  #phase: Phase = "new";
  #lastTimestamp: SimulationTimestamp | null = null;

  constructor(strategy: Strategy<TConfig>) {
    this.strategy = strategy;
  }

  get phase(): Phase {
    return this.#phase;
  }

  init(params: StrategyInitParams<TConfig>): void {
    this.#expect("new", "init");
    this.strategy.init(params);
    this.#phase = "ready";
  }

  step(context: StrategyContext): void {
    if (this.#phase !== "ready" && this.#phase !== "rebalanced") {
      this.#fail("step");
    }
    const ts = context.market.timestamp;
    if (this.#lastTimestamp !== null && ts <= this.#lastTimestamp) {
      throw new LifecycleOrderError(
        `step timestamp ${ts} must be after previous tick ${this.#lastTimestamp}`
      );
    }
    this.strategy.step(context);
    this.#lastTimestamp = ts;
    this.#phase = "stepped";
  }

  rebalance(context: StrategyContext): readonly Order[] {
    this.#expect("stepped", "rebalance");
    if (context.market.timestamp !== this.#lastTimestamp) {
      throw new LifecycleOrderError(
        "rebalance must use the same tick as the preceding step"
      );
    }
    const orders = this.strategy.rebalance(context);
    this.#phase = "rebalanced";
    return orders;
  }

  /** Allowed after init or after any completed tick, not mid-tick. */
  close(context: StrategyContext): readonly Order[] {
    if (this.#phase !== "ready" && this.#phase !== "rebalanced") {
      this.#fail("close");
    }
    const orders = this.strategy.close(context);
    this.#phase = "closed";
    return orders;
  }

  #expect(phase: Phase, call: string): void {
    if (this.#phase !== phase) this.#fail(call);
  }

  #fail(call: string): never {
    throw new LifecycleOrderError(
      `${call}() is not allowed in phase "${this.#phase}"`
    );
  }
}

export interface BuyAndHoldConfig {
  readonly asset: AssetSymbol;
}

/**
 * Left unspent so the entry fill can absorb fees and slippage. Sizing to the
 * whole balance rejects the order under any fill cost above the mark.
 */
const ENTRY_HEADROOM_BPS = 50n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Reference strategy: buys the configured asset at the first rebalance,
 * holds, and sells everything at close.
 */
export class BuyAndHoldStrategy implements Strategy<BuyAndHoldConfig> {
  readonly name = "buy-and-hold";
  #asset: AssetSymbol | null = null;
  #capital = 0n;
  #entered = false;

  init(params: StrategyInitParams<BuyAndHoldConfig>): void {
    this.#asset = params.config.asset;
    this.#capital = params.startingCapital.toStroops();
    this.#entered = false;
  }

  step(_context: StrategyContext): void {}

  rebalance(context: StrategyContext): readonly Order[] {
    if (this.#entered || this.#asset === null) return [];
    const price = context.market.prices.get(this.#asset);
    if (!price || price.toStroops() <= 0n) return [];
    const spendable =
      (this.#capital * (BPS_DENOMINATOR - ENTRY_HEADROOM_BPS)) /
      BPS_DENOMINATOR;
    const size = (spendable * STROOPS_PER_UNIT) / price.toStroops();
    // Nothing to order below one stroop. Leave `#entered` false so a later
    // tick can still enter instead of latching the strategy shut.
    if (size === 0n) return [];
    this.#entered = true;
    return [
      {
        asset: this.#asset,
        size: FixedPointDecimal.fromStroops(size),
        reason: "initial allocation",
      },
    ];
  }

  close(context: StrategyContext): readonly Order[] {
    if (this.#asset === null) return [];
    const position = context.portfolio.getPosition(this.#asset);
    if (!position || position.size.toStroops() === 0n) return [];
    return [
      {
        asset: this.#asset,
        size: FixedPointDecimal.fromStroops(-position.size.toStroops()),
        reason: "unwind at run end",
      },
    ];
  }
}
