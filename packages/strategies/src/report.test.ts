import { describe, it, expect } from "vitest";
import {
  SCENARIO_SCHEMA_VERSION,
  ScenarioValidationError,
  durationToMilliseconds,
  toIsoInstant,
} from "./scenario";
import type { Scenario } from "./scenario";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, SimulationTimestamp } from "./types";
import {
  REPORT_FORMAT_VERSION,
  serializeReport,
  deserializeReport,
  reportToJSON,
  reportFromJSON,
  buildWarmStartContext,
  mergeReports,
  UnknownReportVersionError,
  isUnknownReportVersionError,
} from "./report";
import type {
  RunReport,
  ReportRiskMetrics,
  EventCounts,
  ReportPortfolioState,
} from "./report";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const T0: SimulationTimestamp = 1_700_000_000_000;
const T1: SimulationTimestamp = T0 + 86_400_000; // +1 day
const T2: SimulationTimestamp = T1 + 86_400_000; // +2 days

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";

const STEP = "P1D";
const ENGINE_VERSION = "0.1.0";

function makeScenario(
  start: SimulationTimestamp,
  end: SimulationTimestamp
): Scenario {
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    window: { start: toIsoInstant(start), end: toIsoInstant(end), step: STEP },
    assets: [USDC, EURC],
    source: { price: "horizon", rate: "blend" },
    startingCapital: "150",
    strategy: {
      id: "delta-neutral",
      version: "1",
      params: { targetLeverage: "2", neutralityBandBps: "50" },
    },
    seed: "report-tests",
  };
}

function makeRiskMetrics(
  maxDrawdown: string,
  sharpeProxy: string,
  volatility: string
): ReportRiskMetrics {
  return {
    maxDrawdown: FixedPointDecimal.fromString(maxDrawdown),
    sharpeProxy: FixedPointDecimal.fromString(sharpeProxy),
    volatility: FixedPointDecimal.fromString(volatility),
  };
}

function makeEventCounts(partial?: Partial<EventCounts>): EventCounts {
  return {
    rebalances: 3,
    deposits: 1,
    withdrawals: 0,
    priceFeedMisses: 2,
    ...partial,
  };
}

function makePortfolioState(
  timestamp: SimulationTimestamp,
  usdcAmt: string,
  eurcAmt: string,
  totalValue: string
): ReportPortfolioState {
  return {
    timestamp,
    holdings: {
      USDC: FixedPointDecimal.fromString(usdcAmt),
      EURC: FixedPointDecimal.fromString(eurcAmt),
    },
    totalValue: FixedPointDecimal.fromString(totalValue),
  };
}

function makeReport(start = T0, end = T1, finalTs = T1): RunReport {
  return {
    version: REPORT_FORMAT_VERSION,
    scenario: makeScenario(start, end),
    engineVersion: ENGINE_VERSION,
    riskMetrics: makeRiskMetrics("0.0500000", "0.0120000", "0.0080000"),
    eventCounts: makeEventCounts(),
    finalState: makePortfolioState(
      finalTs,
      "100.5000000",
      "50.2500000",
      "154.3200000"
    ),
  };
}

// ─── Round-trip fidelity ──────────────────────────────────────────────────────

describe("serializeReport / deserializeReport", () => {
  it("round-trips a report without value drift", () => {
    const original = makeReport();
    const restored = deserializeReport(serializeReport(original));

    expect(restored.version).toBe(original.version);

    // The scenario is everything needed to reproduce the run, so it is compared
    // whole rather than field by field.
    expect(restored.scenario).toEqual(original.scenario);
    expect(restored.engineVersion).toBe(original.engineVersion);

    // Risk metrics – compare at stroop level so no float drift can occur
    expect(restored.riskMetrics.maxDrawdown.toStroops()).toBe(
      original.riskMetrics.maxDrawdown.toStroops()
    );
    expect(restored.riskMetrics.sharpeProxy.toStroops()).toBe(
      original.riskMetrics.sharpeProxy.toStroops()
    );
    expect(restored.riskMetrics.volatility.toStroops()).toBe(
      original.riskMetrics.volatility.toStroops()
    );

    // Event counts
    expect(restored.eventCounts).toEqual(original.eventCounts);

    // Final state
    expect(restored.finalState.timestamp).toBe(original.finalState.timestamp);
    expect(restored.finalState.totalValue.toStroops()).toBe(
      original.finalState.totalValue.toStroops()
    );
    expect(restored.finalState.holdings[USDC]!.toStroops()).toBe(
      original.finalState.holdings[USDC]!.toStroops()
    );
    expect(restored.finalState.holdings[EURC]!.toStroops()).toBe(
      original.finalState.holdings[EURC]!.toStroops()
    );
  });

  it("carries the seed, source, capital and strategy config that determine the run", () => {
    const restored = deserializeReport(serializeReport(makeReport()));

    expect(restored.scenario.seed).toBe("report-tests");
    expect(restored.scenario.source).toEqual({
      price: "horizon",
      rate: "blend",
    });
    expect(restored.scenario.startingCapital).toBe("150");
    expect(restored.scenario.strategy.params).toEqual({
      targetLeverage: "2",
      neutralityBandBps: "50",
    });
  });

  it("preserves full 7-decimal-place precision for tiny values", () => {
    const report: RunReport = {
      ...makeReport(),
      riskMetrics: makeRiskMetrics("0.0000001", "0.0000001", "0.0000001"),
      finalState: makePortfolioState(T1, "0.0000001", "0.0000001", "0.0000002"),
    };

    const restored = deserializeReport(serializeReport(report));

    expect(restored.riskMetrics.maxDrawdown.toStroops()).toBe(1n);
    expect(restored.finalState.holdings[USDC]!.toStroops()).toBe(1n);
    expect(restored.finalState.totalValue.toStroops()).toBe(2n);
  });

  it("preserves large stroop values without precision loss", () => {
    // 1,000,000 USDC — stroops: 10_000_000_000_000
    const report: RunReport = {
      ...makeReport(),
      finalState: makePortfolioState(T1, "1000000", "0", "1000000"),
    };

    const restored = deserializeReport(serializeReport(report));
    expect(restored.finalState.holdings[USDC]!.toStroops()).toBe(
      10_000_000_000_000n
    );
    expect(restored.finalState.totalValue.toStroops()).toBe(
      10_000_000_000_000n
    );
  });

  it("serialized holdings are stroop strings, not decimal strings", () => {
    const report = makeReport();
    const wire = serializeReport(report);
    // Each holding value must be a plain integer string (no dot)
    for (const val of Object.values(wire.finalState.holdings)) {
      expect(val).toMatch(/^-?\d+$/);
    }
    expect(wire.riskMetrics.maxDrawdown).toMatch(/^-?\d+$/);
  });

  it("assets array order is preserved", () => {
    const report = makeReport();
    const wire = serializeReport(report);
    expect(wire.scenario.assets).toEqual(["USDC", "EURC"]);
    const restored = deserializeReport(wire);
    expect(restored.scenario.assets).toEqual(["USDC", "EURC"]);
  });

  it("rejects a malformed stroop value instead of reading it as a number", () => {
    // `BigInt("")` is 0n and `BigInt("0x10")` is 16n, so an unvalidated
    // deserializer would turn a corrupted report into a real position.
    for (const malformed of ["", " ", "0x10", "+5", "1.5", "12abc"]) {
      const wire = serializeReport(makeReport());
      const corrupted = {
        ...wire,
        finalState: {
          ...wire.finalState,
          holdings: { ...wire.finalState.holdings, USDC: malformed },
        },
      };
      expect(() => deserializeReport(corrupted)).toThrow(TypeError);
    }
  });

  it("rejects a scenario the engine would refuse, rather than carrying it", () => {
    const wire = serializeReport(makeReport());
    const corrupted = {
      ...wire,
      scenario: { ...wire.scenario, seed: "" },
    };

    expect(() => deserializeReport(corrupted)).toThrow(ScenarioValidationError);
  });
});

// ─── JSON round-trip ─────────────────────────────────────────────────────────

describe("reportToJSON / reportFromJSON", () => {
  it("produces valid JSON and round-trips without loss", () => {
    const original = makeReport();
    const json = reportToJSON(original);

    expect(() => JSON.parse(json)).not.toThrow();

    const restored = reportFromJSON(json);
    expect(restored.finalState.totalValue.toStroops()).toBe(
      original.finalState.totalValue.toStroops()
    );
    expect(restored.eventCounts).toEqual(original.eventCounts);
    expect(restored.scenario).toEqual(original.scenario);
  });

  it("JSON contains no bigint literals (safe for all JSON parsers)", () => {
    const json = reportToJSON(makeReport());
    // BigInt JSON serialisation would either throw or produce a non-string.
    // Verify the stroop fields are quoted strings in the raw JSON.
    const parsed = JSON.parse(json);
    expect(typeof parsed.finalState.totalValue).toBe("string");
    expect(typeof parsed.riskMetrics.maxDrawdown).toBe("string");
  });
});

// ─── Version checking ────────────────────────────────────────────────────────

describe("version checking", () => {
  it("accepts the current supported version", () => {
    const wire = serializeReport(makeReport());
    expect(() => deserializeReport(wire)).not.toThrow();
  });

  it("throws UnknownReportVersionError for a future version", () => {
    const wire = serializeReport(makeReport());
    const futurewire = { ...wire, version: 99 };
    expect(() => deserializeReport(futurewire)).toThrow(
      UnknownReportVersionError
    );
  });

  it("throws UnknownReportVersionError for version 0", () => {
    const wire = serializeReport(makeReport());
    const oldWire = { ...wire, version: 0 };
    expect(() => deserializeReport(oldWire)).toThrow(UnknownReportVersionError);
  });

  it("error message names both the stored and supported versions", () => {
    const wire = serializeReport(makeReport());
    const badWire = { ...wire, version: 42 };
    try {
      deserializeReport(badWire);
      expect.fail("should have thrown");
    } catch (err) {
      expect(isUnknownReportVersionError(err)).toBe(true);
      if (isUnknownReportVersionError(err)) {
        expect(err.storedVersion).toBe(42);
        expect(err.supportedVersion).toBe(REPORT_FORMAT_VERSION);
        expect(err.message).toContain("42");
        expect(err.message).toContain(String(REPORT_FORMAT_VERSION));
      }
    }
  });

  it("does not silently misparse an unknown version", () => {
    const wire = serializeReport(makeReport());
    const badWire = { ...wire, version: 2 };
    let threw = false;
    try {
      deserializeReport(badWire);
    } catch (err) {
      threw = true;
      expect(isUnknownReportVersionError(err)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it("isUnknownReportVersionError returns false for plain errors", () => {
    expect(isUnknownReportVersionError(new Error("other"))).toBe(false);
    expect(isUnknownReportVersionError("string")).toBe(false);
    expect(isUnknownReportVersionError(null)).toBe(false);
  });
});

// ─── Warm-start ──────────────────────────────────────────────────────────────

describe("buildWarmStartContext", () => {
  it("returns a context whose startingState matches the base finalState", () => {
    const base = makeReport(T0, T1, T1);
    const ctx = buildWarmStartContext(base, { newEndTimestamp: T2 });

    expect(ctx.startingState.timestamp).toBe(base.finalState.timestamp);
    expect(ctx.startingState.totalValue.toStroops()).toBe(
      base.finalState.totalValue.toStroops()
    );
    expect(ctx.startingState.holdings[USDC]!.toStroops()).toBe(
      base.finalState.holdings[USDC]!.toStroops()
    );
  });

  it("scenario window starts at finalState.timestamp and ends at newEndTimestamp", () => {
    const base = makeReport(T0, T1, T1);
    const ctx = buildWarmStartContext(base, { newEndTimestamp: T2 });

    expect(Date.parse(ctx.scenario.window.start)).toBe(T1);
    expect(Date.parse(ctx.scenario.window.end)).toBe(T2);
  });

  it("inherits the base scenario's step, assets, source, strategy and seed", () => {
    const base = makeReport();
    const ctx = buildWarmStartContext(base, { newEndTimestamp: T2 });

    expect(ctx.scenario.window.step).toBe(base.scenario.window.step);
    expect(ctx.scenario.assets).toEqual(base.scenario.assets);
    expect(ctx.scenario.source).toEqual(base.scenario.source);
    expect(ctx.scenario.strategy).toEqual(base.scenario.strategy);
    expect(ctx.scenario.seed).toBe(base.scenario.seed);
  });

  it("starts the continuation from the value the run ended on", () => {
    const base = makeReport();
    const ctx = buildWarmStartContext(base, { newEndTimestamp: T2 });

    expect(ctx.scenario.startingCapital).toBe(
      base.finalState.totalValue.toString()
    );
  });

  it("throws RangeError if newEndTimestamp is not strictly after finalState", () => {
    const base = makeReport(T0, T1, T1);
    expect(() => buildWarmStartContext(base, { newEndTimestamp: T1 })).toThrow(
      RangeError
    );
    expect(() =>
      buildWarmStartContext(base, { newEndTimestamp: T1 - 1 })
    ).toThrow(RangeError);
  });

  it("throws RangeError when the window is not a whole number of steps", () => {
    // The run's clock rejects a window its step does not divide evenly, so a
    // context carrying one would only fail later, inside the run.
    const base = makeReport(T0, T1, T1);

    expect(() =>
      buildWarmStartContext(base, { newEndTimestamp: T1 + 3_600_000 })
    ).toThrow(RangeError);
  });

  it("throws when the final value cannot serve as a starting capital", () => {
    const wipedOut: RunReport = {
      ...makeReport(T0, T1, T1),
      finalState: makePortfolioState(T1, "0", "0", "0"),
    };

    expect(() =>
      buildWarmStartContext(wipedOut, { newEndTimestamp: T2 })
    ).toThrow(ScenarioValidationError);
  });
});

// ─── Warm-start equivalence ──────────────────────────────────────────────────
// Simulate a strategy that updates holdings by a fixed rate each step.
// Run it in one shot and via warm-start, then verify the outputs match.

function simulateRun(
  startState: ReportPortfolioState,
  scenario: Scenario
): RunReport {
  // Simple toy strategy: each day adds 0.0010000 USDC per step, no EURC change.
  const stepMs = durationToMilliseconds(scenario.window.step);
  const endTimestamp = Date.parse(scenario.window.end);
  let usdcStroops = startState.holdings[USDC]?.toStroops() ?? 0n;
  const eurcStroops = startState.holdings[EURC]?.toStroops() ?? 0n;
  const gainPerStep = 10_000n; // 0.0010000 USDC in stroops

  let rebalances = 0;
  let ts = startState.timestamp;
  while (ts + stepMs <= endTimestamp) {
    ts += stepMs;
    usdcStroops += gainPerStep;
    rebalances++;
  }

  const totalValueStroops = usdcStroops + eurcStroops;

  return {
    version: REPORT_FORMAT_VERSION,
    scenario,
    engineVersion: ENGINE_VERSION,
    riskMetrics: {
      maxDrawdown: FixedPointDecimal.fromStroops(0n),
      sharpeProxy: FixedPointDecimal.fromStroops(gainPerStep),
      volatility: FixedPointDecimal.fromStroops(0n),
    },
    eventCounts: {
      rebalances,
      deposits: 0,
      withdrawals: 0,
      priceFeedMisses: 0,
    },
    finalState: {
      timestamp: ts,
      holdings: {
        USDC: FixedPointDecimal.fromStroops(usdcStroops),
        EURC: FixedPointDecimal.fromStroops(eurcStroops),
      },
      totalValue: FixedPointDecimal.fromStroops(totalValueStroops),
    },
  };
}

describe("warm-start equivalence", () => {
  const T3 = T2 + 86_400_000; // +3 days from T0

  it("a warm-started continuation produces the same final state as an uninterrupted run", () => {
    // `simulateRun` is deterministic, adding a constant per step and drawing
    // nothing from the RNG, so this covers portfolio-state continuity across a
    // split. It does not cover RNG continuity, which the report cannot provide
    // because it stores no generator state.
    const initialState: ReportPortfolioState = makePortfolioState(
      T0,
      "100",
      "50",
      "150"
    );

    // Uninterrupted full run T0 → T3
    const fullScenario = makeScenario(T0, T3);
    const fullReport = simulateRun(initialState, fullScenario);

    // Split run: T0 → T2, then warm-start T2 → T3
    const firstHalfScenario = makeScenario(T0, T2);
    const firstHalfReport = simulateRun(initialState, firstHalfScenario);

    const ctx = buildWarmStartContext(firstHalfReport, { newEndTimestamp: T3 });
    const secondHalfReport = simulateRun(ctx.startingState, ctx.scenario);

    const merged = mergeReports(firstHalfReport, secondHalfReport, {
      newEndTimestamp: T3,
      mergeEventCounts: true,
    });

    // Final USDC holdings must match exactly
    expect(merged.finalState.holdings[USDC]!.toStroops()).toBe(
      fullReport.finalState.holdings[USDC]!.toStroops()
    );

    // Total portfolio value must match exactly
    expect(merged.finalState.totalValue.toStroops()).toBe(
      fullReport.finalState.totalValue.toStroops()
    );

    // Rebalance counts must add up
    expect(merged.eventCounts.rebalances).toBe(
      fullReport.eventCounts.rebalances
    );
  });

  it("merged scenario spans the full window", () => {
    const initialState = makePortfolioState(T0, "100", "50", "150");
    const firstReport = simulateRun(initialState, makeScenario(T0, T1));
    const ctx = buildWarmStartContext(firstReport, { newEndTimestamp: T2 });
    const secondReport = simulateRun(ctx.startingState, ctx.scenario);

    const merged = mergeReports(firstReport, secondReport, {
      newEndTimestamp: T2,
    });

    expect(Date.parse(merged.scenario.window.start)).toBe(T0);
    expect(Date.parse(merged.scenario.window.end)).toBe(T2);
    expect(merged.scenario.window.step).toBe(STEP);
  });

  it("mergeReports with mergeEventCounts=false uses continuation counts only", () => {
    const initialState = makePortfolioState(T0, "100", "50", "150");
    const firstReport = simulateRun(initialState, makeScenario(T0, T1));
    const ctx = buildWarmStartContext(firstReport, { newEndTimestamp: T2 });
    const secondReport = simulateRun(ctx.startingState, ctx.scenario);

    const merged = mergeReports(firstReport, secondReport, {
      newEndTimestamp: T2,
      mergeEventCounts: false,
    });

    expect(merged.eventCounts.rebalances).toBe(
      secondReport.eventCounts.rebalances
    );
  });

  it("mergeReports keeps the deeper of the two drawdowns", () => {
    // Drawdowns in this report are non-negative magnitudes, so the deeper one
    // is the larger value. Asserted from both orderings so that always
    // favouring the base or always favouring the continuation cannot pass.
    const withDrawdown = (
      drawdown: string,
      start: SimulationTimestamp,
      end: SimulationTimestamp
    ) => ({
      ...makeReport(start, end, end),
      riskMetrics: makeRiskMetrics(drawdown, "0", "0"),
    });

    const shallowBase = withDrawdown("0.0200000", T0, T1);
    const deepBase = withDrawdown("0.3000000", T0, T1);
    const continuation = withDrawdown("0.1000000", T1, T2);

    expect(
      mergeReports(shallowBase, continuation, {
        newEndTimestamp: T2,
      }).riskMetrics.maxDrawdown.toStroops()
    ).toBe(1_000_000n);

    expect(
      mergeReports(deepBase, continuation, {
        newEndTimestamp: T2,
      }).riskMetrics.maxDrawdown.toStroops()
    ).toBe(3_000_000n);
  });

  it("mergeReports throws RangeError when continuation start != base final timestamp", () => {
    const base = makeReport(T0, T1, T1);
    // Window starts at T0 rather than at the base's final timestamp.
    const badContinuation = makeReport(T0, T2, T2);

    expect(() =>
      mergeReports(base, badContinuation, { newEndTimestamp: T2 })
    ).toThrow(RangeError);
  });

  it("mergeReports compares window instants, not their string spelling", () => {
    // The schema accepts both `...T00:00:00Z` and `...T00:00:00.000Z` for the
    // same moment, so a stricter continuation must still merge.
    const base = makeReport(T0, T1, T1);
    const millisContinuation: RunReport = {
      ...makeReport(T1, T2, T2),
      scenario: {
        ...makeScenario(T1, T2),
        window: {
          ...makeScenario(T1, T2).window,
          start: new Date(T1).toISOString(),
        },
      },
    };

    expect(() =>
      mergeReports(base, millisContinuation, { newEndTimestamp: T2 })
    ).not.toThrow();
  });

  it("mergeReports throws RangeError when the continuation ends before the requested end", () => {
    const firstReport = simulateRun(
      makePortfolioState(T0, "100", "50", "150"),
      makeScenario(T0, T1)
    );
    const ctx = buildWarmStartContext(firstReport, { newEndTimestamp: T2 });
    // One hour short of the requested end, so the continuation does not cover
    // the window it is being merged into.
    const shortContinuation = simulateRun(ctx.startingState, {
      ...ctx.scenario,
      window: { ...ctx.scenario.window, end: toIsoInstant(T2 - 3_600_000) },
    });

    expect(() =>
      mergeReports(firstReport, shortContinuation, { newEndTimestamp: T2 })
    ).toThrow(RangeError);
  });

  it("mergeReports throws RangeError when the engine version changed mid-run", () => {
    const base = makeReport(T0, T1, T1);
    const continuation: RunReport = {
      ...makeReport(T1, T2, T2),
      engineVersion: "0.2.0",
    };

    expect(() =>
      mergeReports(base, continuation, { newEndTimestamp: T2 })
    ).toThrow(RangeError);
  });

  // Every field `runConfigMismatch` compares, so a guard cannot be dropped
  // without a test failing. The two `strategy.params` rows cover a differing
  // value and a differing key count. The two `assets` rows cover a shorter set
  // and a reordered one of equal length, since asset order is part of the
  // scenario.
  const CONFIG_MISMATCHES: Array<[string, Partial<Scenario>]> = [
    ["seed", { seed: "another-seed" }],
    ["source.price", { source: { price: "defillama", rate: "blend" } }],
    ["source.rate", { source: { price: "horizon", rate: "defindex" } }],
    [
      "strategy.id",
      {
        strategy: {
          id: "momentum",
          version: "1",
          params: { targetLeverage: "2", neutralityBandBps: "50" },
        },
      },
    ],
    [
      "strategy.version",
      {
        strategy: {
          id: "delta-neutral",
          version: "2",
          params: { targetLeverage: "2", neutralityBandBps: "50" },
        },
      },
    ],
    [
      "strategy.params",
      {
        strategy: {
          id: "delta-neutral",
          version: "1",
          params: { targetLeverage: "3", neutralityBandBps: "50" },
        },
      },
    ],
    [
      "strategy.params",
      {
        strategy: {
          id: "delta-neutral",
          version: "1",
          params: { targetLeverage: "2" },
        },
      },
    ],
    ["assets", { assets: [USDC] }],
    ["assets", { assets: [EURC, USDC] }],
  ];

  it.each(CONFIG_MISMATCHES)(
    "mergeReports throws RangeError when %s changed mid-run",
    (_field, overrides) => {
      const base = makeReport(T0, T1, T1);
      const continuation: RunReport = {
        ...makeReport(T1, T2, T2),
        scenario: { ...makeScenario(T1, T2), ...overrides },
      };

      expect(() =>
        mergeReports(base, continuation, { newEndTimestamp: T2 })
      ).toThrow(RangeError);
    }
  );

  it("mergeReports treats a reordered params block as the same config", () => {
    const base = makeReport(T0, T1, T1);
    const reordered: RunReport = {
      ...makeReport(T1, T2, T2),
      scenario: {
        ...makeScenario(T1, T2),
        strategy: {
          ...makeScenario(T1, T2).strategy,
          params: { neutralityBandBps: "50", targetLeverage: "2" },
        },
      },
    };

    expect(() =>
      mergeReports(base, reordered, { newEndTimestamp: T2 })
    ).not.toThrow();
  });

  it("mergeReports throws RangeError when the step changed mid-run", () => {
    const base = makeReport(T0, T1, T1);
    const continuation: RunReport = {
      ...makeReport(T1, T2, T2),
      scenario: {
        ...makeScenario(T1, T2),
        window: { ...makeScenario(T1, T2).window, step: "PT12H" },
      },
    };

    expect(() =>
      mergeReports(base, continuation, { newEndTimestamp: T2 })
    ).toThrow(RangeError);
  });

  it("warm-start preserves holdings of all assets, not just USDC", () => {
    const initialState = makePortfolioState(T0, "200", "100", "300");
    const firstReport = simulateRun(initialState, makeScenario(T0, T1));
    const ctx = buildWarmStartContext(firstReport, { newEndTimestamp: T2 });

    // EURC holdings must be carried into the continuation unchanged
    expect(ctx.startingState.holdings[EURC]!.toStroops()).toBe(
      firstReport.finalState.holdings[EURC]!.toStroops()
    );
  });
});

// ─── Report carries full reproduction data ───────────────────────────────────

describe("report completeness", () => {
  it("serialized report contains all scenario fields", () => {
    const report = makeReport();
    const wire = serializeReport(report);

    expect(wire.scenario.window.start).toBeDefined();
    expect(wire.scenario.window.end).toBeDefined();
    expect(wire.scenario.window.step).toBeDefined();
    expect(wire.scenario.assets.length).toBeGreaterThan(0);
    expect(wire.scenario.source).toBeDefined();
    expect(wire.scenario.startingCapital).toBeDefined();
    expect(wire.scenario.strategy).toBeDefined();
    expect(wire.scenario.seed).toBeDefined();
    expect(wire.engineVersion).toBeDefined();
  });

  it("report version matches REPORT_FORMAT_VERSION constant", () => {
    const report = makeReport();
    expect(report.version).toBe(REPORT_FORMAT_VERSION);

    const wire = serializeReport(report);
    expect(wire.version).toBe(REPORT_FORMAT_VERSION);
  });

  it("holds all four event-count categories", () => {
    // Asserted through the round trip, since reading the fixture back would
    // pass even if the serializer dropped a category.
    const restored = deserializeReport(
      serializeReport({
        ...makeReport(),
        eventCounts: makeEventCounts({
          rebalances: 3,
          deposits: 1,
          withdrawals: 2,
          priceFeedMisses: 4,
        }),
      })
    );

    expect(restored.eventCounts).toEqual({
      rebalances: 3,
      deposits: 1,
      withdrawals: 2,
      priceFeedMisses: 4,
    });
  });
});
