import { describe, expect, it } from "vitest";

import { SimulationClock, ONE_HOUR_MS } from "../clock";
import { BacktestPriceFeed } from "../feeds";
import { ZERO_COSTS } from "../costs";
import type { AccrualConfig } from "../backtest";
import { Portfolio } from "../portfolio";
import type {
  PortfolioView,
  PositionView,
  Strategy,
  StrategyContext,
} from "../strategy";
import { BuyAndHoldStrategy } from "../strategy";
import { FixedPointDecimal } from "../types";
import type { AssetSymbol, SimulationTimestamp } from "../types";
import { CompositionConstraintError } from "./constraint-engine";
import { runBacktest } from "../backtest";
import type { ExecutionConfig } from "../backtest";
import {
  deserializeComposedAttribution,
  runComposedBacktest,
  serializeComposedAttribution,
} from "./backtest-runner";
import { ComposedStrategy } from "./index";

const USDC: AssetSymbol = "USDC";
const START = 1_700_000_000_000;
const amount = (value: string) => FixedPointDecimal.fromString(value);

const PRICES: ReadonlyMap<AssetSymbol, FixedPointDecimal> = new Map([
  [USDC, amount("1")],
  ["EURC", amount("1")],
]);

function staticPortfolio(
  cash: string,
  positions: ReadonlyArray<{
    asset: AssetSymbol;
    size: string;
    memberId?: string;
  }>
): PortfolioView {
  const views: PositionView[] = positions.map((position) => ({
    asset: position.asset,
    size: amount(position.size),
    basis: amount("0"),
    ...(position.memberId === undefined ? {} : { memberId: position.memberId }),
  }));
  return {
    cash: amount(cash),
    getPosition: (asset) => views.find((view) => view.asset === asset),
    positions: () => views,
    totalValue: (prices) => {
      let total = amount(cash);
      for (const view of views) {
        const price = prices.get(view.asset);
        if (price === undefined) {
          throw new RangeError(`no price for ${view.asset}`);
        }
        total = total.add(view.size.mul(price));
      }
      return total;
    },
  };
}

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

function composedBacktest(
  strategy: ComposedStrategy,
  assets: readonly AssetSymbol[],
  usdcPrices: readonly string[],
  eurcPrices: readonly string[],
  execution?: ExecutionConfig,
  accrual?: AccrualConfig
) {
  const end = START + (usdcPrices.length - 1) * ONE_HOUR_MS;
  return runComposedBacktest({
    clock: new SimulationClock({
      start: START,
      end,
      stepMs: ONE_HOUR_MS,
    }),
    assets,
    prices: BacktestPriceFeed.create({
      USDC: usdcPrices.map((price, index) => ({
        timestamp: START + index * ONE_HOUR_MS,
        price,
      })),
      EURC: eurcPrices.map((price, index) => ({
        timestamp: START + index * ONE_HOUR_MS,
        price,
      })),
    }),
    strategy,
    initialCash: amount("1000"),
    ...(execution === undefined ? {} : { execution }),
    ...(accrual === undefined ? {} : { accrual }),
  });
}

describe("ComposedStrategy", () => {
  it("scopes venue positions to each composed member", () => {
    const observed = new Map<string, readonly string[]>();
    const observe = (id: string): Strategy<null> => ({
      name: id,
      init: () => undefined,
      step: (context: StrategyContext) => {
        observed.set(
          id,
          (context.venues?.venues() ?? []).map(
            (position) => `${position.venueId}:${position.asset}`
          )
        );
      },
      rebalance: () => [],
      close: () => [],
    });
    const strategy = new ComposedStrategy([
      {
        id: "first",
        strategy: observe("first"),
        allocation: amount("0.5"),
        config: null,
      },
      {
        id: "second",
        strategy: observe("second"),
        allocation: amount("0.5"),
        config: null,
      },
    ]);
    const portfolio = new Portfolio(amount("100"));
    portfolio.applyVenueOrder(
      {
        kind: "deploy",
        venueId: "first-venue",
        asset: USDC,
        amount: amount("10"),
        memberId: "first",
      },
      PRICES
    );
    portfolio.applyVenueOrder(
      {
        kind: "deploy",
        venueId: "second-venue",
        asset: USDC,
        amount: amount("10"),
        memberId: "second",
      },
      PRICES
    );

    strategy.init({ startingCapital: amount("100"), config: undefined });
    strategy.step({
      market: {
        timestamp: START as SimulationTimestamp,
        prices: PRICES,
      },
      portfolio,
      venues: portfolio,
    });

    expect(observed.get("first")).toEqual(["first-venue:USDC"]);
    expect(observed.get("second")).toEqual(["second-venue:USDC"]);
  });

  it("attributes a composition trading disjoint assets", () => {
    const strategy = new ComposedStrategy([
      {
        id: "usdc-member",
        strategy: new BuyAndHoldStrategy(),
        allocation: amount("0.5"),
        config: { asset: USDC },
      },
      {
        id: "eurc-member",
        strategy: new BuyAndHoldStrategy(),
        allocation: amount("0.5"),
        config: { asset: "EURC" },
      },
    ]);

    const result = composedBacktest(
      strategy,
      [USDC, "EURC"],
      ["100", "110"],
      ["1", "2"],
      {
        costSchedule: {
          ...ZERO_COSTS,
          swapFeeRate: amount("0.001"),
        },
      }
    );

    expect(
      result.attribution.members.every(
        ({ totalFees }) => totalFees.toStroops() > 0n
      )
    ).toBe(true);
    expect(
      result.attribution.members
        .reduce(
          (total, member) => total.add(member.pnlContribution),
          amount("0")
        )
        .toString()
    ).toBe(result.attribution.totalPnl.toString());
    expect(
      result.attribution.members
        .reduce((total, member) => total.add(member.totalFees), amount("0"))
        .toString()
    ).toBe(result.totalFees.toString());
  });

  it("keeps same-asset attribution separate and serializes deterministically", () => {
    const build = () => {
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
      const result = composedBacktest(
        strategy,
        [USDC],
        ["100", "110"],
        ["1", "1"]
      );
      return serializeComposedAttribution(result.attribution);
    };

    const serialized = build();

    expect(serialized).toBe(build());
    expect(
      serializeComposedAttribution(deserializeComposedAttribution(serialized))
    ).toBe(serialized);
    expect(JSON.parse(serialized)).toMatchObject({
      members: [
        { id: "first", finalValue: "549.75", pnlContribution: "49.75" },
        { id: "second", finalValue: "549.75", pnlContribution: "49.75" },
      ],
    });
  });

  it("keeps an exited member's proceeds attributed as cash", () => {
    let entered = false;
    const exitsAfterOneTick: Strategy<null> = {
      name: "enter-then-exit",
      init: () => undefined,
      step: () => undefined,
      rebalance: (context) => {
        const position = context.portfolio.getPosition(USDC);
        if (position !== undefined) {
          return [{ asset: USDC, size: amount("-1") }];
        }
        if (!entered) {
          entered = true;
          return [{ asset: USDC, size: amount("1") }];
        }
        return [];
      },
      close: () => [],
    };
    const strategy = new ComposedStrategy([
      {
        id: "exiting",
        strategy: exitsAfterOneTick,
        allocation: amount("0.5"),
        config: null,
      },
      {
        id: "cash",
        strategy: {
          name: "cash-only",
          init: () => undefined,
          step: () => undefined,
          rebalance: () => [],
          close: () => [],
        },
        allocation: amount("0.5"),
        config: null,
      },
    ]);

    const result = composedBacktest(
      strategy,
      [USDC],
      ["100", "110", "120"],
      ["1", "1", "1"]
    );
    const exiting = result.attribution.members[0]!;

    expect(exiting.snapshots.map(({ value }) => value.toString())).toEqual([
      "500",
      "510",
      "510",
    ]);
    expect(exiting.finalValue.toString()).toBe("510");
    expect(exiting.pnlContribution.toString()).toBe("10");
  });

  it("attributes funding and cash interest to the owning member", () => {
    const strategy = new ComposedStrategy([
      {
        id: "invested",
        strategy: new BuyAndHoldStrategy(),
        allocation: amount("0.5"),
        config: { asset: USDC },
      },
      {
        id: "cash-only",
        strategy: {
          name: "cash-only",
          init: () => undefined,
          step: () => undefined,
          rebalance: () => [],
          close: () => [],
        },
        allocation: amount("0.5"),
        config: null,
      },
    ]);

    const result = composedBacktest(
      strategy,
      [USDC],
      ["100", "100"],
      ["1", "1"],
      undefined,
      {
        cashRatePerSecond: amount("0.0001"),
        fundingRate: { ratePerSecond: amount("0.0001") },
      }
    );

    expect(result.attribution.members[0]!.pnlContribution.toString()).toBe(
      "-178.2"
    );
    expect(result.attribution.members[1]!.pnlContribution.toString()).toBe(
      "180"
    );
    expect(
      result.attribution.members
        .reduce(
          (total, member) => total.add(member.pnlContribution),
          amount("0")
        )
        .toString()
    ).toBe(result.attribution.totalPnl.toString());
  });

  it("attributes nested member activity to its top-level member", () => {
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

    const result = composedBacktest(
      strategy,
      [USDC],
      ["100", "110"],
      ["1", "1"]
    );

    expect(result.attribution.members).toHaveLength(1);
    expect(result.attribution.members[0]!.id).toBe("outer");
    expect(result.attribution.members[0]!.pnlContribution.toString()).toBe(
      "99.5"
    );
  });

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

  it("rejects a member count limit at init", () => {
    const noop: Strategy<null> = {
      name: "noop",
      init: () => undefined,
      step: () => undefined,
      rebalance: () => [],
      close: () => [],
    };
    const strategy = new ComposedStrategy(
      [
        {
          id: "first",
          strategy: noop,
          allocation: amount("0.5"),
          config: null,
        },
        {
          id: "second",
          strategy: noop,
          allocation: amount("0.5"),
          config: null,
        },
      ],
      { constraints: { maxMemberCount: 1 } }
    );

    expect(() =>
      strategy.init({ startingCapital: amount("1000"), config: undefined })
    ).toThrow(CompositionConstraintError);
  });

  it("rejects a rebalance that breaches aggregate exposure", () => {
    const buy = (): Strategy<null> => ({
      name: "buy",
      init: () => undefined,
      step: () => undefined,
      rebalance: () => [{ asset: USDC, size: amount("300") }],
      close: () => [],
    });
    const strategy = new ComposedStrategy(
      [
        {
          id: "first",
          strategy: buy(),
          allocation: amount("0.5"),
          config: null,
        },
        {
          id: "second",
          strategy: buy(),
          allocation: amount("0.5"),
          config: null,
        },
      ],
      { constraints: { maxAggregateExposure: amount("0.5") } }
    );
    strategy.init({
      startingCapital: amount("1000"),
      config: undefined,
    });

    expect(() =>
      strategy.rebalance({
        market: { timestamp: 1, prices: PRICES },
        portfolio: staticPortfolio("1000", []),
      })
    ).toThrow(CompositionConstraintError);
  });

  it("clamps a rebalance that would breach aggregate exposure", () => {
    const buy = (): Strategy<null> => ({
      name: "buy",
      init: () => undefined,
      step: () => undefined,
      rebalance: () => [{ asset: USDC, size: amount("300") }],
      close: () => [],
    });
    const strategy = new ComposedStrategy(
      [
        {
          id: "first",
          strategy: buy(),
          allocation: amount("0.5"),
          config: null,
        },
        {
          id: "second",
          strategy: buy(),
          allocation: amount("0.5"),
          config: null,
        },
      ],
      {
        constraints: { maxAggregateExposure: amount("0.5") },
        mode: "clamp",
      }
    );
    strategy.init({
      startingCapital: amount("1000"),
      config: undefined,
    });

    const orders = strategy.rebalance({
      market: { timestamp: 1, prices: PRICES },
      portfolio: staticPortfolio("1000", []),
    });

    const totalSize = orders.reduce(
      (total, order) => total + order.size.toStroops(),
      0n
    );
    expect(totalSize).toBeLessThanOrEqual(amount("500").toStroops());
    expect(totalSize).toBeGreaterThan(0n);
    expect(orders.map((order) => order.memberId)).toEqual(["first", "second"]);
  });

  it("measures member weight from the member's own positions", () => {
    const noop: Strategy<null> = {
      name: "noop",
      init: () => undefined,
      step: () => undefined,
      rebalance: () => [],
      close: () => [],
    };
    const strategy = new ComposedStrategy(
      [
        {
          id: "heavy",
          strategy: noop,
          allocation: amount("0.5"),
          config: null,
        },
        {
          id: "light",
          strategy: noop,
          allocation: amount("0.5"),
          config: null,
        },
      ],
      { constraints: { maxMemberWeight: amount("0.7") } }
    );
    strategy.init({
      startingCapital: amount("1000"),
      config: undefined,
    });

    expect(() =>
      strategy.rebalance({
        market: { timestamp: 1, prices: PRICES },
        portfolio: staticPortfolio("0", [
          { asset: USDC, size: "800", memberId: "heavy" },
          { asset: USDC, size: "200", memberId: "light" },
        ]),
      })
    ).toThrow(CompositionConstraintError);
  });

  it("counts nested member positions toward member weight", () => {
    const noop: Strategy<null> = {
      name: "noop",
      init: () => undefined,
      step: () => undefined,
      rebalance: () => [],
      close: () => [],
    };
    const inner = new ComposedStrategy([
      {
        id: "inner",
        strategy: noop,
        allocation: amount("1"),
        config: null,
      },
    ]);
    const strategy = new ComposedStrategy(
      [
        {
          id: "outer",
          strategy: inner,
          allocation: amount("0.5"),
          config: undefined,
        },
        {
          id: "other",
          strategy: noop,
          allocation: amount("0.5"),
          config: null,
        },
      ],
      { constraints: { maxMemberWeight: amount("0.7") } }
    );
    strategy.init({
      startingCapital: amount("1000"),
      config: undefined,
    });

    expect(() =>
      strategy.rebalance({
        market: { timestamp: 1, prices: PRICES },
        portfolio: staticPortfolio("0", [
          { asset: USDC, size: "800", memberId: "outer/inner" },
          { asset: USDC, size: "200", memberId: "other" },
        ]),
      })
    ).toThrow(CompositionConstraintError);
  });
});
