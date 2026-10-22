import { describe, expect, it } from "vitest";

import { SimulationClock, ONE_HOUR_MS } from "../clock";
import { BacktestPriceFeed } from "../feeds";
import type { Strategy } from "../strategy";
import { BuyAndHoldStrategy } from "../strategy";
import { FixedPointDecimal } from "../types";
import type { AssetSymbol } from "../types";
import { runBacktest } from "../backtest";
import { ComposedStrategy } from "./index";

const USDC: AssetSymbol = "USDC";
const START = 1_700_000_000_000;
const amount = (value: string) => FixedPointDecimal.fromString(value);

function backtest(strategy: Strategy<unknown>, funding = false) {
  return runBacktest({
    clock: new SimulationClock({
      start: START,
      end: START + ONE_HOUR_MS,
      stepMs: ONE_HOUR_MS,
    }),
    assets: [USDC],
    prices: BacktestPriceFeed.create({
      USDC: [
        { timestamp: START, price: "100" },
        { timestamp: START + ONE_HOUR_MS, price: "100" },
      ],
      EURC: [
        { timestamp: START, price: "1" },
        { timestamp: START + ONE_HOUR_MS, price: "1" },
      ],
    }),
    strategy,
    strategyConfig: undefined,
    initialCash: amount("1000"),
    ...(funding
      ? { accrual: { fundingRate: { ratePerSecond: amount("0.0001") } } }
      : {}),
  });
}

describe("ComposedStrategy", () => {
  it("keeps same-asset positions separate through a backtest", () => {
    const strategy = new ComposedStrategy([
      {
        id: "first",
        strategy: new BuyAndHoldStrategy(),
        allocation: amount("0.5"),
        config: { asset: USDC },
      },
      {
        id: "second",
        strategy: new BuyAndHoldStrategy(),
        allocation: amount("0.5"),
        config: { asset: USDC },
      },
    ]);

    const result = backtest(strategy, true);

    expect(result.snapshots[0]?.positions).toEqual([
      {
        asset: USDC,
        memberId: "first",
        size: amount("4.975"),
        basis: amount("497.5"),
      },
      {
        asset: USDC,
        memberId: "second",
        size: amount("4.975"),
        basis: amount("497.5"),
      },
    ]);
    expect(result.totalFunding.toString()).toBe("-358.2");
    expect(result.finalValue.toString()).toBe("641.8");
  });

  it("initializes and drives members in declaration order with allocated capital", () => {
    const events: string[] = [];
    const makeStrategy = (id: string): Strategy<null> => ({
      name: id,
      init: ({ startingCapital }) => {
        events.push(`init:${id}:${startingCapital.toString()}`);
      },
      step: () => events.push(`step:${id}`),
      rebalance: () => {
        events.push(`rebalance:${id}`);
        return [];
      },
      close: () => {
        events.push(`close:${id}`);
        return [];
      },
    });
    const strategy = new ComposedStrategy([
      {
        id: "first",
        strategy: makeStrategy("first"),
        allocation: amount("0.6"),
        config: null,
      },
      {
        id: "second",
        strategy: makeStrategy("second"),
        allocation: amount("0.4"),
        config: null,
      },
    ]);

    backtest(strategy);

    expect(events).toEqual([
      "init:first:600",
      "init:second:400",
      "step:first",
      "step:second",
      "rebalance:first",
      "rebalance:second",
      "step:first",
      "step:second",
      "rebalance:first",
      "rebalance:second",
      "close:first",
      "close:second",
    ]);
  });

  it("preserves nested member namespaces", () => {
    const strategy = new ComposedStrategy([
      {
        id: "outer",
        strategy: new ComposedStrategy([
          {
            id: "inner",
            strategy: new BuyAndHoldStrategy(),
            allocation: amount("1"),
            config: { asset: USDC },
          },
        ]),
        allocation: amount("1"),
        config: undefined,
      },
    ]);

    const result = backtest(strategy);

    expect(result.snapshots[0]?.positions[0]?.memberId).toBe("outer/inner");
    expect(result.finalValue.toString()).toBe("1000");
  });
});
