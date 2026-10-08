import { describe, expect, it } from "vitest";

import { ONE_DAY_MS, ONE_HOUR_MS, SimulationClock } from "../clock";
import { BacktestPriceFeed } from "../feeds";
import { FixedBpsSlippageModel } from "../slippage-model";
import { BuyAndHoldStrategy } from "../strategy";
import type { Order, Strategy, StrategyContext } from "../strategy";
import { FixedPointDecimal } from "../types";
import type { AssetSymbol } from "../types";
import { runBacktest, serializeSnapshots } from "./runner";
import type { BacktestResult } from "./runner";

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";
const START = 1_700_000_000_000;

const amount = (value: string) => FixedPointDecimal.fromString(value);

/** A run of `steps` hourly ticks beginning at START. */
const hourly = (steps: number) =>
  new SimulationClock({
    start: START,
    end: START + steps * ONE_HOUR_MS,
    stepMs: ONE_HOUR_MS,
  });

/**
 * One USDC price per tick, taken from `prices` in tick order, so a test states
 * the path it is testing rather than interpolating between endpoints. EURC is
 * carried at a flat price because the feed wants every asset, but no test here
 * trades it.
 */
const feed = (...prices: string[]) =>
  BacktestPriceFeed.create({
    USDC: prices.map((price, index) => ({
      timestamp: START + index * ONE_HOUR_MS,
      price,
    })),
    EURC: prices.map((_, index) => ({
      timestamp: START + index * ONE_HOUR_MS,
      price: "1",
    })),
  });

/** A flat USDC price across a span of `milliseconds`, for window tests. */
const flat = (milliseconds: number) =>
  BacktestPriceFeed.create({
    USDC: [
      { timestamp: START, price: "100" },
      { timestamp: START + milliseconds, price: "100" },
    ],
    EURC: [{ timestamp: START, price: "1" }],
  });

/**
 * Records the cash the strategy was handed at each `step`, and optionally buys
 * once on the first `rebalance`, so a test can tell what the runner applied
 * before the strategy ran from what it applied after.
 */
function observer(entry?: Order): { strategy: Strategy<null>; seen: string[] } {
  const seen: string[] = [];
  let entered = false;
  return {
    seen,
    strategy: {
      name: "observer",
      init: () => undefined,
      step: (context: StrategyContext) => {
        seen.push(context.portfolio.cash.toString());
      },
      rebalance: () => {
        if (entry === undefined || entered) return [];
        entered = true;
        return [entry];
      },
      close: () => [],
    },
  };
}

const hold = () => ({
  strategy: new BuyAndHoldStrategy(),
  strategyConfig: { asset: USDC },
});

describe("runBacktest", () => {
  it("reproduces a hand-worked buy-and-hold run", () => {
    // The reference strategy leaves 50 bps unspent so its entry fill can
    // absorb costs, so 1000 cash buys 995 / 100 = 9.95 units at tick 0.
    const result = runBacktest({
      clock: hourly(2),
      assets: [USDC],
      prices: feed("100", "110", "121"),
      ...hold(),
      initialCash: amount("1000"),
    });

    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots.map((s) => s.timestamp)).toEqual([
      START,
      START + ONE_HOUR_MS,
      START + 2 * ONE_HOUR_MS,
    ]);
    expect(result.snapshots.map((s) => s.cash.toString())).toEqual([
      "5",
      "5",
      "5",
    ]);
    expect(result.snapshots.map((s) => s.value.toString())).toEqual([
      "1000",
      "1099.5",
      "1208.95",
    ]);
    expect(result.snapshots[0]?.positions).toEqual([
      {
        asset: USDC,
        size: amount("9.95"),
        basis: amount("995"),
      },
    ]);

    // Close sells the position at the last mark, so the result ends in cash.
    expect(result.finalValue.toString()).toBe("1208.95");
    expect(result.initialCash.toString()).toBe("1000");
    expect(result.totalFees.toString()).toBe("0");
  });

  it("accrues and fills before the strategy sees the portfolio, then snapshots", () => {
    const { strategy, seen } = observer({ asset: USDC, size: amount("9.95") });
    const result = runBacktest({
      clock: hourly(2),
      assets: [USDC],
      prices: feed("100", "100", "100"),
      strategy,
      strategyConfig: null,
      initialCash: amount("1000"),
      accrual: {
        cashRatePerSecond: amount("0.0001"),
        fundingRate: { ratePerSecond: amount("0.0001") },
      },
    });

    // The entry fill lands at tick 0, so 1000 becomes 5 and stays there until
    // the first interval closes. Tick 1 then credits funding of
    // 995 * 0.0001 * 3600 = 358.2 on the position marked at 100 and interest
    // of 5 * 0.0001 * 3600 = 1.8 on the cash, and the strategy is handed the
    // sum. Tick 2 accrues on that larger balance instead.
    expect(seen).toEqual(["1000", "365", "854.6"]);
    expect(result.totalFunding.toString()).toBe("716.4");
    expect(result.totalInterest.toString()).toBe("133.2");
    expect(result.snapshots.map((s) => s.cash.toString())).toEqual([
      "5",
      "365",
      "854.6",
    ]);
    expect(result.snapshots.map((s) => s.value.toString())).toEqual([
      "1000",
      "1360",
      "1849.6",
    ]);
  });

  it("prorates accrual to the clock step", () => {
    const window = ONE_DAY_MS;
    const run = (clock: SimulationClock) => {
      const { strategy } = observer({ asset: USDC, size: amount("9.95") });
      return runBacktest({
        clock,
        assets: [USDC],
        prices: flat(window),
        strategy,
        strategyConfig: null,
        initialCash: amount("1000"),
        accrual: { fundingRate: { ratePerSecond: amount("0.0001") } },
      });
    };

    const hourlyTotal = run(
      new SimulationClock({
        start: START,
        end: START + window,
        stepMs: ONE_HOUR_MS,
      })
    ).totalFunding;
    const dailyTotal = run(
      new SimulationClock({ start: START, end: START + window, stepMs: window })
    ).totalFunding;

    // Funding is charged on the marked notional, which does not grow, so 24
    // hourly intervals and one daily interval accrue the identical total.
    // 995 * 0.0001 * 86400 = 8596.8.
    expect(dailyTotal.toString()).toBe("8596.8");
    expect(hourlyTotal.toString()).toBe("8596.8");
  });

  it("fills orders through the cost model after slippage", () => {
    const result = runBacktest({
      clock: hourly(1),
      assets: [USDC],
      prices: feed("100", "100"),
      ...hold(),
      initialCash: amount("1000"),
      execution: {
        slippageModel: new FixedBpsSlippageModel(100n),
        costSchedule: {
          swapFeeRate: amount("0.001"),
          borrowSpreadRate: amount("0"),
          networkFee: amount("0.1"),
        },
      },
    });

    // The entry buys 9.95 units at a 1% worse price, so 1004.95 of notional
    // and 1004.95 * 0.001 + 0.1 = 1.10495 of cost, which the 50 bps the
    // strategy withheld does not cover. Closing sells at 1% worse than the
    // mark instead, so the second fill costs 985.05 * 0.001 + 0.1 and leaves
    // 977.91. The closing leg is why the total is not simply the entry cost.
    expect(result.snapshots[0]?.cash.toString()).toBe("-6.05495");
    expect(result.totalFees.toString()).toBe("2.19");
    expect(result.finalValue.toString()).toBe("977.91");
  });

  it("reduces a position on a sell and settles the cash", () => {
    const scale: Strategy<null> = {
      name: "scale-out",
      init: () => undefined,
      step: () => undefined,
      rebalance: (context) => {
        const held = context.portfolio.getPosition(USDC);
        if (held === undefined) return [{ asset: USDC, size: amount("10") }];
        if (held.size.equals(amount("10"))) {
          return [{ asset: USDC, size: amount("-4") }];
        }
        return [];
      },
      close: () => [],
    };

    const result = runBacktest({
      clock: hourly(2),
      assets: [USDC],
      prices: feed("100", "100", "100"),
      strategy: scale,
      strategyConfig: null,
      initialCash: amount("1000"),
    });

    // Buying 10 at 100 spends the lot. Selling 4 of those at the same price
    // releases four tenths of the basis, so cash recovers 400 and the position
    // keeps 600 of basis against 6 units.
    expect(result.snapshots[0]?.cash.toString()).toBe("0");
    expect(result.snapshots[0]?.positions).toEqual([
      { asset: USDC, size: amount("10"), basis: amount("1000") },
    ]);
    expect(result.snapshots[1]?.cash.toString()).toBe("400");
    expect(result.snapshots[1]?.positions).toEqual([
      { asset: USDC, size: amount("6"), basis: amount("600") },
    ]);
    expect(result.snapshots[1]?.value.toString()).toBe("1000");
  });

  it("records every held position, sorted, on every snapshot", () => {
    const both: Strategy<null> = {
      name: "both-assets",
      init: () => undefined,
      step: () => undefined,
      rebalance: (): Order[] => [
        { asset: USDC, size: amount("2") },
        { asset: EURC, size: amount("300") },
      ],
      close: () => [],
    };

    const result = runBacktest({
      clock: hourly(1),
      assets: [USDC, EURC],
      prices: feed("100", "100"),
      strategy: both,
      strategyConfig: null,
      initialCash: amount("1000"),
    });

    // Positions come out in asset order rather than fill order, and both are
    // marked: 2 * 100 + 300 * 1 back alongside the 500 of cash left over.
    expect(result.snapshots[0]?.positions).toEqual([
      { asset: EURC, size: amount("300"), basis: amount("300") },
      { asset: USDC, size: amount("2"), basis: amount("200") },
    ]);
    expect(result.snapshots[0]?.cash.toString()).toBe("500");
    expect(result.snapshots[0]?.value.toString()).toBe("1000");
  });

  it("produces byte-identical snapshots for identical inputs", () => {
    const build = (): BacktestResult =>
      runBacktest({
        clock: hourly(3),
        assets: [USDC],
        prices: feed("100", "108", "99", "121"),
        ...hold(),
        initialCash: amount("1000"),
        execution: {
          slippageModel: new FixedBpsSlippageModel(25n),
          costSchedule: {
            swapFeeRate: amount("0.0005"),
            borrowSpreadRate: amount("0"),
            networkFee: amount("0.01"),
          },
        },
        accrual: {
          cashRatePerSecond: amount("0.00001"),
          fundingRate: { ratePerSecond: amount("0.00002") },
        },
      });

    expect(serializeSnapshots(build().snapshots)).toBe(
      serializeSnapshots(build().snapshots)
    );
    expect(() =>
      JSON.parse(serializeSnapshots(build().snapshots))
    ).not.toThrow();
  });

  it("serializes snapshots to a canonical string", () => {
    const result = runBacktest({
      clock: hourly(1),
      assets: [USDC],
      prices: feed("100", "110"),
      ...hold(),
      initialCash: amount("1000"),
    });

    expect(serializeSnapshots(result.snapshots)).toBe(
      `[{"index":0,"timestamp":${START},"cash":"5",` +
        `"positions":[{"asset":"USDC","size":"9.95","basis":"995"}],` +
        `"value":"1000"},` +
        `{"index":1,"timestamp":${START + ONE_HOUR_MS},"cash":"5",` +
        `"positions":[{"asset":"USDC","size":"9.95","basis":"995"}],` +
        `"value":"1099.5"}]`
    );
  });

  it("drives the lifecycle once per tick in order, then closes once", () => {
    const calls: string[] = [];
    const strategy: Strategy<null> = {
      name: "recorder",
      init: ({ startingCapital }) => {
        calls.push(`init:${startingCapital.toString()}`);
      },
      step: (context) => {
        calls.push(`step:${context.market.timestamp - START}`);
      },
      rebalance: (context) => {
        calls.push(`rebalance:${context.market.timestamp - START}`);
        return [];
      },
      close: () => {
        calls.push("close");
        return [];
      },
    };

    runBacktest({
      clock: hourly(2),
      assets: [USDC],
      prices: feed("100", "100", "100"),
      strategy,
      strategyConfig: null,
      initialCash: amount("1000"),
    });

    expect(calls).toEqual([
      "init:1000",
      "step:0",
      "rebalance:0",
      `step:${ONE_HOUR_MS}`,
      `rebalance:${ONE_HOUR_MS}`,
      `step:${2 * ONE_HOUR_MS}`,
      `rebalance:${2 * ONE_HOUR_MS}`,
      "close",
    ]);
  });

  it("rejects an order for an asset the run does not price", () => {
    const stray: Strategy<null> = {
      name: "stray",
      init: () => undefined,
      step: () => undefined,
      rebalance: (): Order[] => [{ asset: EURC, size: amount("1") }],
      close: () => [],
    };

    expect(() =>
      runBacktest({
        clock: hourly(1),
        assets: [USDC],
        prices: feed("100", "100"),
        strategy: stray,
        strategyConfig: null,
        initialCash: amount("1000"),
      })
    ).toThrow(/no price for "EURC"/);
  });

  it("rejects an order with no size", () => {
    const empty: Strategy<null> = {
      name: "empty",
      init: () => undefined,
      step: () => undefined,
      rebalance: (): Order[] => [{ asset: USDC, size: amount("0") }],
      close: () => [],
    };

    expect(() =>
      runBacktest({
        clock: hourly(1),
        assets: [USDC],
        prices: feed("100", "100"),
        strategy: empty,
        strategyConfig: null,
        initialCash: amount("1000"),
      })
    ).toThrow(/quantity must be positive/i);
  });

  it("follows the portfolio's cash rule rather than refusing an over-buy", () => {
    // `Portfolio` documents that cash may go negative, so the runner does not
    // add a second, stricter rule on top of it.
    const overBuy: Strategy<null> = {
      name: "over-buy",
      init: () => undefined,
      step: () => undefined,
      rebalance: (): Order[] => [{ asset: USDC, size: amount("20") }],
      close: () => [],
    };

    const result = runBacktest({
      clock: hourly(0),
      assets: [USDC],
      prices: feed("100"),
      strategy: overBuy,
      strategyConfig: null,
      initialCash: amount("1000"),
    });

    expect(result.snapshots[0]?.cash.toString()).toBe("-1000");
    expect(result.snapshots[0]?.value.toString()).toBe("1000");
  });

  it("leaves an open position open when the strategy will not unwind it", () => {
    const buyAndNeverSell: Strategy<null> = {
      name: "no-unwind",
      init: () => undefined,
      step: () => undefined,
      rebalance: (): Order[] => [{ asset: USDC, size: amount("10") }],
      close: () => [],
    };

    const result = runBacktest({
      clock: hourly(1),
      assets: [USDC],
      prices: feed("100", "110"),
      strategy: buyAndNeverSell,
      strategyConfig: null,
      initialCash: amount("1000"),
    });

    expect(result.finalValue.toString()).toBe("1100");
  });
});
