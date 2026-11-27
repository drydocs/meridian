import { describe, it, expect } from "vitest";
import { runBacktest } from "./backtest/runner";
import type { BacktestResult, BacktestSnapshot } from "./backtest/runner";
import { SimulationClock } from "./clock";
import {
  REPORT_FORMAT_VERSION,
  buildWarmStartContext,
  deserializeReport,
  mergeReports,
  reportFromJSON,
  reportToJSON,
  restoreGenerators,
  serializeReport,
} from "./report";
import {
  MissingGeneratorStreamError,
  buildRunReport,
  captureGeneratorStates,
  computeReportRiskMetrics,
  isMissingGeneratorStreamError,
} from "./report-builder";
import { STRATEGY_ENGINE_VERSION } from "./engine";
import { XorShift64 } from "./rng";
import { SCENARIO_SCHEMA_VERSION, toIsoInstant } from "./scenario";
import type { Scenario } from "./scenario";
import type { Order, Strategy } from "./strategy";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, PriceFeed, SimulationTimestamp } from "./types";

const DAY_MS = 86_400_000;
const NO_EVENTS = { deposits: 0, withdrawals: 0, priceFeedMisses: 0 };
const T0: SimulationTimestamp = 1_700_000_000_000;
const T1: SimulationTimestamp = T0 + 3 * DAY_MS;
const T2: SimulationTimestamp = T0 + 6 * DAY_MS;

const USDC: AssetSymbol = "USDC";
const XLM: AssetSymbol = "XLM";

function makeScenario(
  start: SimulationTimestamp,
  end: SimulationTimestamp,
  startingCapital = "1000"
): Scenario {
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    window: {
      start: toIsoInstant(start),
      end: toIsoInstant(end),
      step: "P1D",
    },
    assets: [USDC, XLM],
    source: { price: "horizon", rate: "blend" },
    startingCapital,
    strategy: {
      id: "buy-and-hold",
      version: "1",
      params: { asset: "XLM" },
    },
    costs: { networkFee: "0", swapFeeRate: "0" },
    seed: "report-builder-test",
  };
}

/**
 * Deterministic price feed backed by an `XorShift64` stream for XLM.
 * Each new timestamp draws once from the generator, so a warm-started run
 * resuming from the saved generator state sees the exact same prices as an
 * uninterrupted run.
 */
function makeSeededPriceFeed(
  xlmRng: XorShift64,
  initialPrice = FixedPointDecimal.fromString("1.0000000")
): PriceFeed {
  const prices = new Map<SimulationTimestamp, FixedPointDecimal>();
  let current = initialPrice;

  return {
    getSpotPrice(
      asset: AssetSymbol,
      timestamp: SimulationTimestamp
    ): FixedPointDecimal {
      if (asset === USDC) {
        return FixedPointDecimal.fromString("1");
      }
      const cached = prices.get(timestamp);
      if (cached !== undefined) {
        return cached;
      }
      // Draw a deterministic move in [-5%, +5%]
      const u = xlmRng.nextFloat();
      const factor = FixedPointDecimal.fromString((0.95 + u * 0.1).toFixed(7));
      current = current.mul(factor);
      prices.set(timestamp, current);
      return current;
    },
  };
}

/**
 * Simple strategy that buys `buyAmount` of XLM on the first tick if not
 * already holding it, and holds through the window without closing.
 */
function makeHoldStrategy(
  buyAmount: FixedPointDecimal
): Strategy<unknown, Order> {
  let bought = false;
  return {
    name: "hold-xlm",
    init() {
      bought = false;
    },
    step() {
      // no-op
    },
    rebalance(): readonly Order[] {
      if (!bought && buyAmount.toStroops() > 0n) {
        bought = true;
        return [{ asset: XLM, size: buyAmount }];
      }
      return [];
    },
    close(): readonly Order[] {
      return [];
    },
  };
}

describe("buildRunReport", () => {
  it("builds a complete RunReport from a fresh executed scenario", () => {
    const scenario = makeScenario(T0, T1, "1000");
    const rng = new XorShift64(42n);
    const generators = { "price:XLM": rng };
    const startStates = captureGeneratorStates(generators);

    const clock = new SimulationClock({
      start: T0,
      end: T1,
      stepMs: DAY_MS,
    });
    const result = runBacktest({
      clock,
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(rng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromString("500")),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
    });

    const report = buildRunReport({
      scenario,
      result,
      generators: { start: startStates, end: generators },
      eventCounts: { deposits: 1, withdrawals: 0, priceFeedMisses: 0 },
    });

    expect(report.version).toBe(REPORT_FORMAT_VERSION);
    expect(report.scenario).toEqual(scenario);
    expect(report.engineVersion).toBe(STRATEGY_ENGINE_VERSION);
    expect(report.finalState.timestamp).toBe(T1);
    expect(report.finalState.totalValue.toStroops()).toBe(
      result.finalValue.toStroops()
    );
    expect(report.finalState.holdings.XLM?.toStroops()).toBe(
      FixedPointDecimal.fromString("500").toStroops()
    );
    expect(report.finalState.holdings.USDC).toBeDefined();

    // Risk metrics populated and valid
    expect(report.riskMetrics.maxDrawdown.toStroops()).toBeGreaterThanOrEqual(
      0n
    );
    expect(report.riskMetrics.volatility.toStroops()).toBeGreaterThanOrEqual(
      0n
    );

    // Event counts: rebalances derived (1 position change), deposits explicit
    expect(report.eventCounts.rebalances).toBe(1);
    expect(report.eventCounts.deposits).toBe(1);
    expect(report.eventCounts.withdrawals).toBe(0);
    expect(report.eventCounts.priceFeedMisses).toBe(0);

    // Generator states captured and advanced
    expect(report.generators.start["price:XLM"]).toBe(42n);
    expect(report.generators.end["price:XLM"]).toBe(rng.getState());
    expect(report.generators.end["price:XLM"]).not.toBe(42n);
  });

  it("round-trips generator states and report fields through serialize and deserialize", () => {
    const scenario = makeScenario(T0, T1, "1000");
    const rng = new XorShift64(0xfedcba9876543211n);
    const startStates = captureGeneratorStates({ "price:XLM": rng });

    const result = runBacktest({
      clock: new SimulationClock({ start: T0, end: T1, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(rng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromString("100")),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
    });

    const report = buildRunReport({
      scenario,
      result,
      eventCounts: NO_EVENTS,
      generators: { start: startStates, end: { "price:XLM": rng } },
      engineVersion: "1.2.3",
    });

    const wire = serializeReport(report);
    const restored = deserializeReport(wire);
    expect(restored.generators.start).toEqual(report.generators.start);
    expect(restored.generators.end).toEqual(report.generators.end);
    expect(restored.engineVersion).toBe("1.2.3");
    expect(restored.finalState.totalValue.toStroops()).toBe(
      report.finalState.totalValue.toStroops()
    );

    const fromJson = reportFromJSON(reportToJSON(report));
    expect(fromJson.generators.start).toEqual(report.generators.start);
    expect(fromJson.generators.end).toEqual(report.generators.end);
    expect(fromJson.riskMetrics.maxDrawdown.toStroops()).toBe(
      report.riskMetrics.maxDrawdown.toStroops()
    );
  });

  it("reproduces an uninterrupted run via warm-started continuation", () => {
    const seed = 987654321n;
    const cashRate = FixedPointDecimal.fromString("0.05");

    // 1. Uninterrupted run: T0 -> T2
    const fullRng = new XorShift64(seed);
    const fullStart = captureGeneratorStates({ "price:XLM": fullRng });
    const fullResult = runBacktest({
      clock: new SimulationClock({ start: T0, end: T2, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(fullRng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromStroops(0n)),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
      accrual: { cashRateAnnual: cashRate },
    });
    const fullReport = buildRunReport({
      scenario: makeScenario(T0, T2, "1000"),
      result: fullResult,
      eventCounts: NO_EVENTS,
      generators: { start: fullStart, end: { "price:XLM": fullRng } },
    });

    // 2. First leg: T0 -> T1
    const part1Rng = new XorShift64(seed);
    const part1Start = captureGeneratorStates({ "price:XLM": part1Rng });
    const part1Result = runBacktest({
      clock: new SimulationClock({ start: T0, end: T1, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(part1Rng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromStroops(0n)),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
      accrual: { cashRateAnnual: cashRate },
    });
    const part1Report = reportFromJSON(
      reportToJSON(
        buildRunReport({
          scenario: makeScenario(T0, T1, "1000"),
          result: part1Result,
          eventCounts: NO_EVENTS,
          generators: { start: part1Start, end: { "price:XLM": part1Rng } },
        })
      )
    );

    // 3. Warm-start continuation: T1 -> T2
    const warmCtx = buildWarmStartContext(part1Report, {
      newEndTimestamp: T2,
    });
    const restoredGenerators = restoreGenerators(warmCtx);
    const part2Rng = restoredGenerators["price:XLM"]!;
    const part2Start = captureGeneratorStates(restoredGenerators);

    // The continuation clock starts at T1 (which already had a price drawn at
    // the end of part 1), so advance the feed starting from the first new tick
    // T1 + DAY_MS while keeping T1 at a fixed mark.
    const part2Feed = makeSeededPriceFeed(part2Rng);
    const part2Prices: PriceFeed = {
      getSpotPrice(asset, ts) {
        if (asset === USDC || ts === T1) {
          return FixedPointDecimal.fromString("1");
        }
        return part2Feed.getSpotPrice(asset, ts);
      },
    };

    const part2Result = runBacktest({
      clock: new SimulationClock({ start: T1, end: T2, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: part2Prices,
      strategy: makeHoldStrategy(FixedPointDecimal.fromStroops(0n)),
      strategyConfig: {},
      initialCash: warmCtx.startingState.totalValue,
      accrual: { cashRateAnnual: cashRate },
    });
    const part2Report = buildRunReport({
      scenario: warmCtx.scenario,
      result: part2Result,
      eventCounts: NO_EVENTS,
      generators: { start: part2Start, end: restoredGenerators },
    });

    // 4. Merge and verify against the uninterrupted run
    const merged = mergeReports(part1Report, part2Report, {
      newEndTimestamp: T2,
    });

    expect(merged.generators.start).toEqual(fullReport.generators.start);
    expect(merged.generators.end).toEqual(fullReport.generators.end);
    expect(merged.finalState.timestamp).toBe(fullReport.finalState.timestamp);
    // Cash accrual across 6 days matches within 1 stroop of fractional carry
    const diff =
      merged.finalState.totalValue.toStroops() -
      fullReport.finalState.totalValue.toStroops();
    expect(diff >= -1n && diff <= 1n).toBe(true);
  });

  it("throws MissingGeneratorStreamError when a stream is missing from end states", () => {
    const scenario = makeScenario(T0, T1, "1000");
    const rng = new XorShift64(7n);
    const result = runBacktest({
      clock: new SimulationClock({ start: T0, end: T1, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(rng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromStroops(0n)),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
    });

    let caught: unknown;
    try {
      buildRunReport({
        scenario,
        result,
        eventCounts: NO_EVENTS,
        generators: {
          start: { "price:XLM": 7n, "price:USDC": 9n },
          end: { "price:XLM": rng.getState() },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(isMissingGeneratorStreamError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(MissingGeneratorStreamError);
    expect((caught as MissingGeneratorStreamError).stream).toBe("price:USDC");
    expect((caught as MissingGeneratorStreamError).location).toBe("end");
  });

  it("throws MissingGeneratorStreamError when a stream is missing from start states", () => {
    const scenario = makeScenario(T0, T1, "1000");
    const rng = new XorShift64(7n);
    const result = runBacktest({
      clock: new SimulationClock({ start: T0, end: T1, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(rng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromStroops(0n)),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
    });

    let caught: unknown;
    try {
      buildRunReport({
        scenario,
        result,
        eventCounts: NO_EVENTS,
        generators: {
          start: {},
          end: { "price:XLM": rng.getState() },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(isMissingGeneratorStreamError(caught)).toBe(true);
    expect((caught as MissingGeneratorStreamError).stream).toBe("price:XLM");
    expect((caught as MissingGeneratorStreamError).location).toBe("start");
  });

  it("throws MissingGeneratorStreamError when a required stream is absent", () => {
    const scenario = makeScenario(T0, T1, "1000");
    const rng = new XorShift64(7n);
    const result = runBacktest({
      clock: new SimulationClock({ start: T0, end: T1, stepMs: DAY_MS }),
      assets: [USDC, XLM],
      prices: makeSeededPriceFeed(rng),
      strategy: makeHoldStrategy(FixedPointDecimal.fromStroops(0n)),
      strategyConfig: {},
      initialCash: FixedPointDecimal.fromString("1000"),
    });

    let caught: unknown;
    try {
      buildRunReport({
        scenario,
        result,
        eventCounts: NO_EVENTS,
        generators: { start: {}, end: {} },
        requiredStreams: ["price:XLM"],
      });
    } catch (err) {
      caught = err;
    }

    expect(isMissingGeneratorStreamError(caught)).toBe(true);
    expect((caught as MissingGeneratorStreamError).stream).toBe("price:XLM");
    expect((caught as MissingGeneratorStreamError).location).toBe("start");
  });

  it("computes zero risk metrics for empty snapshots", () => {
    const metrics = computeReportRiskMetrics([]);
    expect(metrics.maxDrawdown.toStroops()).toBe(0n);
    expect(metrics.sharpeProxy.toStroops()).toBe(0n);
    expect(metrics.volatility.toStroops()).toBe(0n);
  });

  function equityCurve(values: number[]): BacktestSnapshot[] {
    return values.map((value, i) => ({
      timestamp: T0 + i * DAY_MS,
      value: FixedPointDecimal.fromStroops(BigInt(value) * 10_000_000n),
    })) as unknown as BacktestSnapshot[];
  }

  it("reports tail and downside metrics for a curve with a loss", () => {
    const metrics = computeReportRiskMetrics(equityCurve([100, 90, 99, 110]));
    expect(metrics.maxDrawdown.toStroops()).toBe(1_000_000n);
    expect(metrics.valueAtRisk.toStroops()).toBe(1_000_000n);
    expect(metrics.conditionalValueAtRisk.toStroops()).toBe(1_000_000n);
    expect(metrics.downsideDeviation.toStroops()).toBeGreaterThan(0n);
    expect(metrics.sortinoRatio).not.toBeNull();
    expect(metrics.calmarRatio).not.toBeNull();
  });

  it("reports null ratios for a curve that never declines", () => {
    const metrics = computeReportRiskMetrics(equityCurve([100, 100, 100]));
    expect(metrics.maxDrawdown.toStroops()).toBe(0n);
    expect(metrics.downsideDeviation.toStroops()).toBe(0n);
    expect(metrics.sortinoRatio).toBeNull();
    expect(metrics.calmarRatio).toBeNull();
  });

  it("reports zero tail metrics when the curve has no returns", () => {
    const metrics = computeReportRiskMetrics(equityCurve([100]));
    expect(metrics.valueAtRisk.toStroops()).toBe(0n);
    expect(metrics.sortinoRatio).toBeNull();
    expect(metrics.calmarRatio).toBeNull();
  });

  const fx = (n: number) =>
    FixedPointDecimal.fromStroops(BigInt(n) * 10_000_000n);
  const states = { start: { "price:XLM": 1n }, end: { "price:XLM": 2n } };

  function handResult(snapshots: unknown[]): BacktestResult {
    return {
      strategyName: "hand",
      initialCash: fx(1000),
      snapshots,
      finalValue: fx(1000),
      strategyEquity: fx(1000),
      totalInterest: fx(0),
      totalFunding: fx(0),
      totalFees: fx(0),
    } as unknown as BacktestResult;
  }

  it("holds initial cash in the quote asset when there are no snapshots", () => {
    const scenario = makeScenario(T0, T1);
    const report = buildRunReport({
      scenario,
      result: handResult([]),
      generators: states,
      eventCounts: NO_EVENTS,
      quoteAsset: "XLM",
    });
    expect(report.finalState.timestamp).toBe(T1);
    expect(report.finalState.holdings.XLM?.toStroops()).toBe(10_000_000_000n);
    expect(report.eventCounts.rebalances).toBe(0);
  });

  it("sums holdings per asset including venue principal and yield", () => {
    const snapshots = [
      {
        timestamp: T0,
        value: fx(1000),
        cash: fx(400),
        positions: [{ memberId: "a", asset: "XLM", size: fx(100) }],
        venues: [
          {
            memberId: "a",
            venueId: "v1",
            asset: "XLM",
            deployedPrincipal: fx(50),
            accruedYield: fx(5),
          },
        ],
      },
      {
        timestamp: T1,
        value: fx(1000),
        cash: fx(400),
        positions: [{ memberId: "a", asset: "XLM", size: fx(100) }],
        venues: [
          {
            memberId: "a",
            venueId: "v1",
            asset: "XLM",
            deployedPrincipal: fx(50),
            accruedYield: fx(9),
          },
        ],
      },
    ];
    const report = buildRunReport({
      scenario: makeScenario(T0, T1),
      result: handResult(snapshots),
      generators: states,
      eventCounts: NO_EVENTS,
    });
    expect(report.finalState.holdings.USDC?.toStroops()).toBe(4_000_000_000n);
    expect(report.finalState.holdings.XLM?.toStroops()).toBe(1_590_000_000n);
    expect(report.eventCounts.rebalances).toBe(1);
  });

  it("uses a caller supplied rebalance count", () => {
    const report = buildRunReport({
      scenario: makeScenario(T0, T1),
      result: handResult([]),
      generators: states,
      eventCounts: { ...NO_EVENTS, rebalances: 4 },
    });
    expect(report.eventCounts.rebalances).toBe(4);
  });
});
