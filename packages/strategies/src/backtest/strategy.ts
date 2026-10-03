import type { Fixed } from "./decimal";
import type { MarketTick } from "./clock";

export type OrderSide = "buy" | "sell";

/** A strategy's intent to trade. `quantity` is always positive. */
export interface Order {
  readonly asset: string;
  readonly side: OrderSide;
  readonly quantity: Fixed;
}

/** Read-only portfolio surface exposed to a strategy. */
export interface PortfolioView {
  readonly cash: Fixed;
  position(asset: string): Fixed;
  value(prices: ReadonlyMap<string, Fixed>): Fixed;
}

/** Everything a strategy sees on a single tick. */
export interface StrategyContext {
  readonly tick: MarketTick;
  readonly portfolio: PortfolioView;
}

/** The strategy lifecycle the runner drives. */
export interface Strategy {
  /** Stable identifier recorded in the backtest result. */
  readonly id: string;
  /** Called once per clock tick, in order, before any fill is applied. */
  onTick(context: StrategyContext): readonly Order[];
  /** Called once after the final tick has settled. */
  onClose?(context: StrategyContext): void;
}

/** Per-fill cost model; both fields are integer basis points. */
export interface ExecutionModel {
  readonly slippageBps: bigint;
  readonly feeBps: bigint;
}

/** Per-tick accrual fractions, applied by `Portfolio.accrue`. */
export interface AccrualRates {
  readonly cashRate: Fixed;
  readonly fundingRate: Fixed;
}
