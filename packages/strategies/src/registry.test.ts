import { describe, it, expect } from "vitest";
import {
  BuyAndHoldStrategy,
  DeltaNeutralStrategy,
  FixedPointDecimal,
  SimulationClock,
  ONE_HOUR_MS,
  StaticPriceFeed,
  StrategyParamsError,
  UnknownStrategyError,
  STRATEGY_DEFINITIONS,
  parseScenario,
  resolveStrategy,
  runBacktest,
} from "./index";

const START = 1_700_000_000_000;
const feed = StaticPriceFeed.create({ USDC: "100", EURC: "100" });

const deltaParams = {
  asset: "USDC",
  targetLeverage: "2",
  rebalanceBandBps: "50",
  fundingRatePerSecond: "0.0000001",
};

describe("resolveStrategy: buy-and-hold", () => {
  it("resolves id and version to a strategy and typed config", () => {
    const { strategy, config } = resolveStrategy("buy-and-hold", "1.0.0", {
      asset: "USDC",
    });
    expect(strategy).toBeInstanceOf(BuyAndHoldStrategy);
    expect(config).toEqual({ asset: "USDC" });
  });

  it("returns a fresh strategy per call", () => {
    const a = resolveStrategy("buy-and-hold", "1.0.0", { asset: "USDC" });
    const b = resolveStrategy("buy-and-hold", "1.0.0", { asset: "USDC" });
    expect(a.strategy).not.toBe(b.strategy);
  });

  it("drives a real backtest from a parsed scenario's strategy block", () => {
    const scenario = parseScenario({
      window: {
        start: "2024-01-01T00:00:00Z",
        end: "2024-01-02T00:00:00Z",
        step: "PT1H",
      },
      assets: ["USDC", "EURC"],
      source: { price: "horizon", rate: "blend" },
      startingCapital: "1000",
      strategy: {
        id: "buy-and-hold",
        version: "1.0.0",
        params: { asset: "USDC" },
      },
      seed: "registry-test",
    });
    const { strategy, config } = resolveStrategy(
      scenario.strategy.id,
      scenario.strategy.version,
      scenario.strategy.params
    );
    const result = runBacktest({
      clock: new SimulationClock({
        start: START,
        end: START + 2 * ONE_HOUR_MS,
        stepMs: ONE_HOUR_MS,
      }),
      assets: ["USDC"],
      prices: feed,
      strategy: strategy as BuyAndHoldStrategy,
      strategyConfig: config as { asset: "USDC" },
      initialCash: FixedPointDecimal.fromString("1000"),
    });
    expect(result.strategyName).toBe("buy-and-hold");
    expect(result.snapshots).toHaveLength(3);
  });

  it.each([
    ["missing asset", {}],
    ["empty asset", { asset: "" }],
    ["unsupported asset", { asset: "DOGE" }],
    ["unknown key", { asset: "USDC", leverage: "2" }],
  ])("rejects params with %s", (_label, params) => {
    expect(() => resolveStrategy("buy-and-hold", "1.0.0", params)).toThrow(
      StrategyParamsError
    );
  });
});

describe("resolveStrategy: delta-neutral", () => {
  it("resolves to a strategy and typed config", () => {
    const { strategy, config } = resolveStrategy(
      "delta-neutral",
      "1.0.0",
      deltaParams,
      { priceFeed: feed }
    );
    expect(strategy).toBeInstanceOf(DeltaNeutralStrategy);
    expect(config.asset).toBe("USDC");
    expect(config.targetLeverage.toString()).toBe("2");
    expect(config.rebalanceBandBps).toBe(50);
    expect(config.fundingRate.ratePerSecond.toStroops()).toBe(1n);
    expect(config.priceFeed).toBe(feed);
    expect(config.hedgeFeed).toBeUndefined();
  });

  it("passes a hedge feed through when supplied", () => {
    const hedge = StaticPriceFeed.create({ USDC: "101", EURC: "100" });
    const { config } = resolveStrategy("delta-neutral", "1.0.0", deltaParams, {
      priceFeed: feed,
      hedgeFeed: hedge,
    });
    expect(config.hedgeFeed).toBe(hedge);
  });

  it("accepts a negative funding rate", () => {
    const { config } = resolveStrategy(
      "delta-neutral",
      "1.0.0",
      { ...deltaParams, fundingRatePerSecond: "-0.0000002" },
      { priceFeed: feed }
    );
    expect(config.fundingRate.ratePerSecond.toStroops()).toBe(-2n);
  });

  it("requires a price feed", () => {
    expect(() =>
      resolveStrategy("delta-neutral", "1.0.0", deltaParams)
    ).toThrow(/priceFeed/);
  });

  it.each([
    "asset",
    "targetLeverage",
    "rebalanceBandBps",
    "fundingRatePerSecond",
  ])("rejects a missing %s", (key) => {
    const params: Record<string, string> = { ...deltaParams };
    delete params[key];
    expect(() =>
      resolveStrategy("delta-neutral", "1.0.0", params, { priceFeed: feed })
    ).toThrow(StrategyParamsError);
  });

  it.each([
    ["targetLeverage", "abc"],
    ["targetLeverage", "0"],
    ["targetLeverage", "-1"],
    ["targetLeverage", "1.23456789"],
    ["targetLeverage", "1e3"],
    ["rebalanceBandBps", "-5"],
    ["rebalanceBandBps", "5.5"],
    ["rebalanceBandBps", "fifty"],
    ["fundingRatePerSecond", "0.00000001"],
    ["fundingRatePerSecond", ""],
    ["asset", "XLM"],
  ])("rejects %s = %j", (key, value) => {
    expect(() =>
      resolveStrategy(
        "delta-neutral",
        "1.0.0",
        { ...deltaParams, [key]: value },
        { priceFeed: feed }
      )
    ).toThrow(StrategyParamsError);
  });

  it("rejects an unknown key", () => {
    expect(() =>
      resolveStrategy(
        "delta-neutral",
        "1.0.0",
        { ...deltaParams, bogus: "1" },
        { priceFeed: feed }
      )
    ).toThrow(/bogus/);
  });
});

describe("resolveStrategy: unknown id or version", () => {
  it("names the id and lists every definition for an unknown id", () => {
    let caught: unknown;
    try {
      resolveStrategy("blend-loop", "1.0.0", {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownStrategyError);
    const error = caught as UnknownStrategyError;
    expect(error.strategyId).toBe("blend-loop");
    expect(error.message).toContain("blend-loop");
    expect(error.message).toContain("buy-and-hold@1.0.0");
    expect(error.message).toContain("delta-neutral@1.0.0");
  });

  it("names the version for a known id at an unknown version", () => {
    expect(() => resolveStrategy("buy-and-hold", "9.9.9", {})).toThrow(
      /buy-and-hold.*9\.9\.9/
    );
  });
});

describe("registry contents", () => {
  it("registers every conforming strategy exactly once", () => {
    expect(STRATEGY_DEFINITIONS.map((d) => `${d.id}@${d.version}`)).toEqual([
      "buy-and-hold@1.0.0",
      "delta-neutral@1.0.0",
    ]);
  });
});
