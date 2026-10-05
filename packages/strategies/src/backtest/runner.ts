import { ZERO, formatFixed } from "./decimal";
import type { Fixed } from "./decimal";
import type { SimulationClock } from "./clock";
import { Portfolio } from "./portfolio";
import type { Snapshot } from "./portfolio";
import type {
  AccrualRates,
  ExecutionModel,
  Strategy,
  StrategyContext,
} from "./strategy";

export interface BacktestConfig {
  readonly clock: SimulationClock;
  readonly strategy: Strategy;
  readonly initialCash: Fixed;
  readonly execution: ExecutionModel;
  readonly accrual: AccrualRates;
}

export interface BacktestResult {
  readonly strategyId: string;
  readonly initialCash: Fixed;
  readonly snapshots: readonly Snapshot[];
  readonly finalValue: Fixed;
  readonly totalInterest: Fixed;
  readonly totalFunding: Fixed;
  readonly totalFees: Fixed;
}

/**
 * Runs one fully deterministic backtest. Every tick applies the same fixed,
 * documented order of operations:
 *
 *   1. accrual  - interest on cash, then funding on positions;
 *   2. strategy - `onTick` sees the accrued portfolio and returns orders;
 *   3. fills    - orders apply in returned order, slippage then fee;
 *   4. snapshot - cash, positions and marked value are recorded.
 *
 * After the final tick, `onClose` is called once and the result is returned.
 */
export function runBacktest(config: BacktestConfig): BacktestResult {
  validate(config);
  const portfolio = new Portfolio(config.initialCash);
  const snapshots: Snapshot[] = [];
  let totalInterest = ZERO;
  let totalFunding = ZERO;
  let totalFees = ZERO;

  for (const tick of config.clock.ticks) {
    const accrual = portfolio.accrue(config.accrual, tick.prices);
    totalInterest += accrual.interest;
    totalFunding += accrual.funding;

    const context: StrategyContext = { tick, portfolio };
    for (const order of config.strategy.onTick(context)) {
      const markPrice = tick.prices.get(order.asset);
      if (markPrice === undefined) {
        throw new RangeError(
          `runBacktest: no price for "${order.asset}" at tick ${tick.index}`
        );
      }
      const fill = portfolio.applyOrder(order, markPrice, config.execution);
      totalFees += fill.fee;
    }

    snapshots.push(portfolio.snapshot(tick));
  }

  const lastTick = config.clock.ticks[config.clock.ticks.length - 1];
  if (!lastTick) throw new RangeError("runBacktest: clock has no ticks");
  config.strategy.onClose?.({ tick: lastTick, portfolio });

  return {
    strategyId: config.strategy.id,
    initialCash: config.initialCash,
    snapshots,
    finalValue: portfolio.value(lastTick.prices),
    totalInterest,
    totalFunding,
    totalFees,
  };
}

/** Canonical, byte-stable JSON for a snapshot sequence. */
export function serializeSnapshots(snapshots: readonly Snapshot[]): string {
  return JSON.stringify(
    snapshots.map((snapshot) => ({
      tick: snapshot.tick,
      timestamp: snapshot.timestamp,
      cash: formatFixed(snapshot.cash),
      positions: serializePositions(snapshot.positions),
      value: formatFixed(snapshot.value),
    }))
  );
}

function serializePositions(
  positions: Readonly<Record<string, Fixed>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const asset of Object.keys(positions).sort()) {
    const quantity = positions[asset];
    if (quantity !== undefined) out[asset] = formatFixed(quantity);
  }
  return out;
}

function validate(config: BacktestConfig): void {
  const { slippageBps, feeBps } = config.execution;
  if (slippageBps < 0n || slippageBps >= 10_000n) {
    throw new RangeError("runBacktest: slippageBps must be in [0, 10000)");
  }
  if (feeBps < 0n) {
    throw new RangeError("runBacktest: feeBps must not be negative");
  }
  if (config.accrual.cashRate < 0n) {
    throw new RangeError("runBacktest: cashRate must not be negative");
  }
  if (config.accrual.fundingRate < 0n) {
    throw new RangeError("runBacktest: fundingRate must not be negative");
  }
}
