import { describe, it, expect } from "vitest";
import {
  FixedPointDecimal,
  BacktestRunner,
  DeltaNeutralStrategy,
  DeltaNeutralStrategyConfig,
  BacktestScenarioSchema,
  MetricsCollector,
  generateTrendingScenario,
  generateRangingScenario,
  generateHighFundingScenario,
} from "./index";

describe("Delta-Neutral Scenario Backtests (#932)", () => {
  const defaultConfig: DeltaNeutralStrategyConfig = {
    initialCapitalQuote: "10000.0000000",
    neutralityBandBps: 20, // 20 bps rebalance threshold
  };

  describe("Scenario Schema Validation (#874)", () => {
    it("validates generated trending scenario against BacktestScenarioSchema", () => {
      const scenario = generateTrendingScenario({ seed: 42, numSteps: 50 });
      const parsed = BacktestScenarioSchema.safeParse(scenario);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.regime).toBe("trending");
        expect(parsed.data.steps.length).toBe(50);
      }
    });

    it("validates generated ranging scenario against BacktestScenarioSchema", () => {
      const scenario = generateRangingScenario({ seed: 101, numSteps: 50 });
      const parsed = BacktestScenarioSchema.safeParse(scenario);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.regime).toBe("ranging");
        expect(parsed.data.steps.length).toBe(50);
      }
    });

    it("validates generated high-funding scenario against BacktestScenarioSchema", () => {
      const scenario = generateHighFundingScenario({ seed: 777, numSteps: 50 });
      const parsed = BacktestScenarioSchema.safeParse(scenario);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.regime).toBe("high-funding");
        expect(parsed.data.steps.length).toBe(50);
      }
    });

    it("rejects invalid scenario with empty steps", () => {
      const invalid = {
        id: "invalid",
        name: "Invalid",
        description: "Empty steps",
        regime: "trending",
        asset: "USDC",
        baseAsset: "USDC",
        quoteAsset: "USD",
        startTimestamp: 0,
        endTimestamp: 0,
        stepIntervalMs: 1000,
        steps: [],
        neutralityBandBps: 50,
      };
      const parsed = BacktestScenarioSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Trending Market Backtest", () => {
    it("preserves net delta within neutrality band despite significant price drift", () => {
      const scenario = generateTrendingScenario({
        seed: 12345,
        numSteps: 100,
        neutralityBandBps: 50, // 50 bps max allowed band
      });

      const strategy = new DeltaNeutralStrategy();
      const summary = BacktestRunner.run({
        scenario,
        strategy,
        config: defaultConfig,
      });

      expect(summary.scenarioId).toBe(scenario.id);
      expect(summary.totalSteps).toBe(100);
      // Assert net delta stays strictly within neutrality band
      expect(summary.withinNeutralityBand).toBe(true);
      expect(Math.abs(summary.maxNetDeltaBps)).toBeLessThanOrEqual(
        scenario.neutralityBandBps
      );
      expect(Math.abs(summary.minNetDeltaBps)).toBeLessThanOrEqual(
        scenario.neutralityBandBps
      );

      // Verify carry PnL earned is strictly positive in uptrend with positive funding
      expect(summary.carryPnl.toStroops()).toBeGreaterThan(0n);

      // Verify delta-neutral property: price PnL is close to 0 compared to spot price swing
      const firstPrice = parseFloat(scenario.steps[0]!.spotPrice);
      const lastPrice = parseFloat(
        scenario.steps[scenario.steps.length - 1]!.spotPrice
      );
      const priceReturn = (lastPrice - firstPrice) / firstPrice;
      expect(priceReturn).toBeGreaterThan(0.1); // > 10% price move

      // Price PnL relative to initial equity is near 0 (< 1%)
      const pricePnlRatio = Math.abs(
        Number(summary.pricePnl.toStroops()) /
          Number(summary.initialEquity.toStroops())
      );
      expect(pricePnlRatio).toBeLessThan(0.01);
    });

    it("is deterministic against a fixed seed", () => {
      const scenario1 = generateTrendingScenario({ seed: 999, numSteps: 50 });
      const scenario2 = generateTrendingScenario({ seed: 999, numSteps: 50 });

      const strategy = new DeltaNeutralStrategy();
      const summary1 = BacktestRunner.run({
        scenario: scenario1,
        strategy,
        config: defaultConfig,
      });
      const summary2 = BacktestRunner.run({
        scenario: scenario2,
        strategy,
        config: defaultConfig,
      });

      expect(summary1.finalEquity.toString()).toBe(
        summary2.finalEquity.toString()
      );
      expect(summary1.carryPnl.toString()).toBe(summary2.carryPnl.toString());
      expect(summary1.maxNetDeltaBps).toBe(summary2.maxNetDeltaBps);
    });
  });

  describe("Ranging Market Backtest", () => {
    it("maintains neutrality and accumulates steady funding carry in sideways market", () => {
      const scenario = generateRangingScenario({
        seed: 54321,
        numSteps: 120,
        neutralityBandBps: 50,
      });

      const strategy = new DeltaNeutralStrategy();
      const summary = BacktestRunner.run({
        scenario,
        strategy,
        config: defaultConfig,
      });

      expect(summary.totalSteps).toBe(120);
      expect(summary.withinNeutralityBand).toBe(true);
      expect(Math.abs(summary.maxNetDeltaBps)).toBeLessThanOrEqual(
        scenario.neutralityBandBps
      );
      expect(Math.abs(summary.minNetDeltaBps)).toBeLessThanOrEqual(
        scenario.neutralityBandBps
      );

      // Carry PnL should be positive
      expect(summary.carryPnl.toStroops()).toBeGreaterThan(0n);

      // Total equity should have increased by carry PnL
      expect(summary.netPnl.toStroops()).toBeGreaterThan(0n);
    });
  });

  describe("High-Funding Scenario Backtest", () => {
    it("accumulates high carry PnL matching the funding model within tolerance", () => {
      const scenario = generateHighFundingScenario({
        seed: 88888,
        numSteps: 100,
        baseFundingRate: 0.001, // 10 bps per step
        neutralityBandBps: 50,
      });

      const strategy = new DeltaNeutralStrategy();
      const summary = BacktestRunner.run({
        scenario,
        strategy,
        config: defaultConfig,
      });

      expect(summary.withinNeutralityBand).toBe(true);

      // Calculate theoretical funding sum: sum(shortNotional * fundingRate)
      let theoreticalCarryStroops = 0n;
      const initialCapital = FixedPointDecimal.fromString(
        defaultConfig.initialCapitalQuote
      );
      const initialPrice = FixedPointDecimal.fromString(
        scenario.steps[0]!.spotPrice
      );
      const initialShortAmountStroops =
        ((initialCapital.toStroops() / 2n) * 10_000_000n) /
        initialPrice.toStroops();

      for (const step of scenario.steps) {
        const perpPrice = FixedPointDecimal.fromString(step.perpPrice);
        const rate = FixedPointDecimal.fromString(step.fundingRate);
        const stepCarry =
          (((initialShortAmountStroops * perpPrice.toStroops()) / 10_000_000n) *
            rate.toStroops()) /
          10_000_000n;
        theoreticalCarryStroops += stepCarry;
      }

      // Assert carry PnL matches theoretical model within 1% tolerance
      const actualCarryStroops = summary.carryPnl.toStroops();
      const diff = Math.abs(
        Number(actualCarryStroops - theoreticalCarryStroops)
      );
      const tolerance = Number(theoreticalCarryStroops) * 0.01; // 1%
      expect(diff).toBeLessThan(tolerance);
      expect(actualCarryStroops).toBeGreaterThan(0n);
    });
  });

  describe("Metrics Collector", () => {
    it("throws when summarizing empty metrics", () => {
      const collector = new MetricsCollector();
      const scenario = generateTrendingScenario({ numSteps: 10 });
      expect(() =>
        collector.summarize(scenario, FixedPointDecimal.fromString("1000"))
      ).toThrow("Cannot summarize empty metrics records");
    });
  });
});
