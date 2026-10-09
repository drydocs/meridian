import { describe, expect, it } from "vitest";

import { runBacktest, serializeSnapshots } from "./backtest";
import type { BacktestResult } from "./backtest";
import { DeltaNeutralStrategy } from "./delta-neutral";
import type { DeltaNeutralConfig } from "./delta-neutral";
import {
  MARKET_REGIMES,
  buildRegimeScenario,
  scenarioClock,
  scenarioDeltaNeutralConfig,
  scenarioPriceFeed,
} from "./regime-scenarios";
import type { MarketRegime, RegimeScenarioOptions } from "./regime-scenarios";
import { FixedPointDecimal } from "./types";

/**
 * Scenario backtests for the three market regimes (#932): the shared runner
 * drives `DeltaNeutralStrategy` over a GBM path built from the scenario's seed.
 *
 * The carry under test is the strategy's own `fundingPnl`, which is the accrual
 * on the short hedge. The runner's accrual is left off because the portfolio's
 * spot leg is a spot holding and pays no funding, and the runner's `finalValue`
 * does not move with it.
 */

interface RegimeRun {
  readonly strategy: DeltaNeutralStrategy;
  readonly result: BacktestResult;
  readonly config: DeltaNeutralConfig;
}

function runRegime(
  regime: MarketRegime,
  options: RegimeScenarioOptions = {}
): RegimeRun {
  const scenario = buildRegimeScenario(regime, options);
  const clock = scenarioClock(scenario);
  const prices = scenarioPriceFeed(scenario);
  const config = scenarioDeltaNeutralConfig(scenario, prices);
  const strategy = new DeltaNeutralStrategy();

  const result = runBacktest({
    clock,
    assets: [config.asset],
    prices,
    strategy,
    strategyConfig: config,
    initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
  });

  return { strategy, result, config };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** The observation series as a comparable string, decimals included. */
function series(run: RegimeRun): string {
  return run.strategy.deltaHistory
    .map(
      (observation) =>
        `${observation.tick}:${observation.price.toString()}:` +
        `${observation.netDeltaNotional.toString()}:${observation.rebalanced}`
    )
    .join("|");
}

describe("delta-neutral scenario backtests", () => {
  it("runs every regime to completion through the shared runner", () => {
    for (const regime of MARKET_REGIMES) {
      const { strategy, result } = runRegime(regime);

      expect(result.strategyName).toBe("delta-neutral");
      expect(result.snapshots).toHaveLength(25);
      expect(strategy.deltaHistory).toHaveLength(25);
      const last = strategy.deltaHistory[strategy.deltaHistory.length - 1]!;
      expect(last.tick).toBe(24);
      expect(strategy.isClosed).toBe(true);
      expect(result.finalValue.toStroops()).toBeGreaterThan(0n);
    }
  });

  it("carries positive funding in every regime", () => {
    const ranging = runRegime("ranging").strategy.fundingPnl;
    const trending = runRegime("trending").strategy.fundingPnl;
    const highFunding = runRegime("high-funding").strategy.fundingPnl;

    expect(ranging.toStroops()).toBeGreaterThan(0n);

    // The regimes rank by their configured funding rate, so the carry has to
    // rank with them even though the paths and their deltas differ.
    expect(trending.toStroops()).toBeGreaterThan(ranging.toStroops());
    expect(highFunding.toStroops()).toBeGreaterThan(trending.toStroops());
  });

  it("scales carry with the configured funding rate", () => {
    const single = runRegime("trending").strategy.fundingPnl;
    const doubled = runRegime("trending", {
      market: { fundingRatePerSecond: "0.0000006" },
    }).strategy.fundingPnl;

    // Carry is close to proportional in the rate but not exactly so. The hedge
    // notional is set from equity, which is itself lifted by the funding being
    // accrued, so a higher rate carries a larger notional along with it, and
    // each tick's accrual then truncates to stroops. The measured deviation at
    // double the rate is under two parts per billion, so a bound of one part
    // per million keeps the check tight while allowing for both.
    const drift = abs(doubled.toStroops() - single.toStroops() * 2n);
    expect(drift * 1_000_000n).toBeLessThan(single.toStroops() * 2n);
  });

  it("rebalances only when the band is breached", () => {
    const tight = runRegime("trending", { neutralityBandBps: 1 }).strategy;
    const wide = runRegime("trending", { neutralityBandBps: 1000 }).strategy;

    // A one basis point band is breached on nearly every tick, and a ten
    // percent band is never breached, so the band is what drives the count.
    expect(tight.rebalanceCount).toBeGreaterThan(0);
    expect(wide.rebalanceCount).toBe(0);
  });

  it("flags every observation that leaves the neutrality band", () => {
    let breaching = 0;

    for (const regime of MARKET_REGIMES) {
      const { strategy, config } = runRegime(regime);

      // The band is `equity x bps / 10_000` at the tick under test. Equity
      // climbs across these runs, so the closing equity gives the widest band
      // of the run, and an observation past it is past its own tick's band too.
      const band =
        (strategy.equity.toStroops() * BigInt(config.rebalanceBandBps)) /
        10_000n;

      const over = strategy.deltaHistory.filter(
        (observation) => abs(observation.netDeltaNotional.toStroops()) > band
      );

      expect(over.every((observation) => observation.rebalanced)).toBe(true);
      breaching += over.length;
    }

    // At least one regime has to drift past the band, otherwise the check above
    // passes without exercising a rebalance.
    expect(breaching).toBeGreaterThan(0);
  });

  it("reproduces identical runs from the same scenario", () => {
    const first = runRegime("trending");
    const second = runRegime("trending");

    expect(series(second)).toBe(series(first));
    expect(serializeSnapshots(second.result.snapshots)).toBe(
      serializeSnapshots(first.result.snapshots)
    );
    expect(second.strategy.fundingPnl.toString()).toBe(
      first.strategy.fundingPnl.toString()
    );
    expect(second.strategy.rebalanceCount).toBe(first.strategy.rebalanceCount);
  });

  it("produces a different path for a different seed", () => {
    const first = runRegime("trending", { seed: "1" });
    const second = runRegime("trending", { seed: "2" });

    expect(series(second)).not.toBe(series(first));
    expect(serializeSnapshots(second.result.snapshots)).not.toBe(
      serializeSnapshots(first.result.snapshots)
    );
  });
});
