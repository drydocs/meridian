import type {
  AssetSymbol,
  FixedPointDecimal,
  SimulationTimestamp,
} from "./types";

/**
 * Direction of an intended order.
 */
export type OrderSide = "buy" | "sell";

/**
 * Which leg of a delta-neutral book an intent targets: the long `spot` leg or
 * the offsetting short `hedge` leg.
 */
export type OrderBook = "spot" | "hedge";

/**
 * A strategy's *intent* to trade. Orders are always expressed as a positive
 * notional in the simulation quote asset plus the mark price at intent time.
 * A strategy never mutates portfolio state directly — it returns the orders it
 * wants the runner to fill (see #872).
 */
export interface Order {
  readonly book: OrderBook;
  readonly asset: AssetSymbol;
  readonly side: OrderSide;
  /** Positive notional, denominated in the simulation quote asset. */
  readonly notional: FixedPointDecimal;
  /** Mark price used to express the intent, in quote per base unit. */
  readonly price: FixedPointDecimal;
}

/** Read-only market context handed to a strategy on each lifecycle call. */
export interface StrategyContext {
  readonly timestamp: SimulationTimestamp;
}

/** `init` additionally receives the starting capital (see #872). */
export interface StrategyInitContext extends StrategyContext {
  readonly capital: FixedPointDecimal;
}

/**
 * The lifecycle every strategy implements (#872): `init` once with the
 * starting capital, `step` once per simulated tick, `rebalance` whenever the
 * strategy may act to restore its target exposure, and `close` once at run end
 * to unwind. Each hook returns the orders it intends the runner to fill; the
 * runner — not the strategy — owns portfolio state.
 */
export interface Strategy {
  readonly id: string;
  init(context: StrategyInitContext): readonly Order[];
  step(context: StrategyContext): readonly Order[];
  rebalance(context: StrategyContext): readonly Order[];
  close(context: StrategyContext): readonly Order[];
}
