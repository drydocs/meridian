import { describe, it, expect } from "vitest";
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
  RunScenario,
  RiskMetrics,
  EventCounts,
  PortfolioState,
} from "./report";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const T0: SimulationTimestamp = 1_700_000_000_000;
const T1: SimulationTimestamp = T0 + 86_400_000; // +1 day
const T2: SimulationTimestamp = T1 + 86_400_000; // +2 days

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";

function makeScenario(
  start: SimulationTimestamp,
  end: SimulationTimestamp
): RunScenario {
  return {
    startTimestamp: start,
    endTimestamp: end,
    assets: [USDC, EURC],
    engineVersion: "0.1.0",
  };
}

function makeRiskMetrics(
  maxDrawdown: string,
  sharpeProxy: string,
  volatility: string
): RiskMetrics {
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
): PortfolioState {
  return {
    timestamp,
    holdings: {
      USDC: FixedPointDecimal.fromString(usdcAmt),
      EURC: FixedPointDecimal.fromString(eurcAmt),
    },
    totalValue: FixedPointDecimal.fromString(totalValue),
  };
}

function makeReport(
  start = T0,
  end = T1,
  finalTs = T1
): RunReport {
  return {
    version: REPORT_FORMAT_VERSION,
    scenario: makeScenario(start, end),
    riskMetrics: makeRiskMetrics("0.0500000", "0.0120000", "0.0080000"),
    eventCounts: makeEventCounts(),
    finalState: makePortfolioState(finalTs, "100.5000000", "50.2500000", "154.3200000"),
  };
}

// ─── Round-trip fidelity ──────────────────────────────────────────────────────

describe("serializeReport / deserializeReport", () => {
  it("round-trips a report without value drift", () => {
    const original = makeReport();
    const restored = deserializeReport(serializeReport(original));

    expect(restored.version).toBe(original.version);

    // Scenario fields
    expect(restored.scenario.startTimestamp).toBe(original.scenario.startTimestamp);
    expect(restored.scenario.endTimestamp).toBe(original.scenario.endTimestamp);
    expect(restored.scenario.assets).toEqual(original.scenario.assets);
    expect(restored.scenario.engineVersion).toBe(original.scenario.engineVersion);

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
    expect(restored.finalState.holdings[USDC]!.toStroops()).toBe(10_000_000_000_000n);
    expect(restored.finalState.totalValue.toStroops()).toBe(10_000_000_000_000n);
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
    expect(() => deserializeReport(futurewire)).toThrow(UnknownReportVersionError);
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

    expect(ctx.scenario.startTimestamp).toBe(T1);
    expect(ctx.scenario.endTimestamp).toBe(T2);
  });

  it("preserves assets and engineVersion from the base report", () => {
    const base = makeReport();
    const ctx = buildWarmStartContext(base, { newEndTimestamp: T2 });

    expect(ctx.scenario.assets).toEqual(base.scenario.assets);
    expect(ctx.scenario.engineVersion).toBe(base.scenario.engineVersion);
  });

  it("throws RangeError if newEndTimestamp is not strictly after finalState", () => {
    const base = makeReport(T0, T1, T1);
    expect(() =>
      buildWarmStartContext(base, { newEndTimestamp: T1 })
    ).toThrow(RangeError);
    expect(() =>
      buildWarmStartContext(base, { newEndTimestamp: T1 - 1 })
    ).toThrow(RangeError);
  });
});

// ─── Warm-start equivalence ──────────────────────────────────────────────────
// Simulate a strategy that updates holdings by a fixed rate each step.
// Run it in one shot and via warm-start, then verify the outputs match.

function simulateRun(
  startState: PortfolioState,
  scenario: RunScenario
): RunReport {
  // Simple toy strategy: each day adds 0.0010000 USDC per step, no EURC change.
  const stepMs = 86_400_000;
  let usdcStroops = startState.holdings[USDC]?.toStroops() ?? 0n;
  const eurcStroops = startState.holdings[EURC]?.toStroops() ?? 0n;
  const gainPerStep = 10_000n; // 0.0010000 USDC in stroops

  let rebalances = 0;
  let ts = startState.timestamp;
  while (ts + stepMs <= scenario.endTimestamp) {
    ts += stepMs;
    usdcStroops += gainPerStep;
    rebalances++;
  }

  const totalValueStroops = usdcStroops + eurcStroops;

  return {
    version: REPORT_FORMAT_VERSION,
    scenario,
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
    const initialState: PortfolioState = makePortfolioState(
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

    expect(merged.scenario.startTimestamp).toBe(T0);
    expect(merged.scenario.endTimestamp).toBe(T2);
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

  it("mergeReports throws RangeError when continuation start != base final timestamp", () => {
    const base = makeReport(T0, T1, T1);
    const badContinuation: RunReport = {
      ...makeReport(T0, T2, T2),
      scenario: makeScenario(T0, T2), // starts at T0, not T1
    };

    expect(() =>
      mergeReports(base, badContinuation, { newEndTimestamp: T2 })
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

    expect(wire.scenario.startTimestamp).toBeDefined();
    expect(wire.scenario.endTimestamp).toBeDefined();
    expect(wire.scenario.assets.length).toBeGreaterThan(0);
    expect(wire.scenario.engineVersion).toBeDefined();
  });

  it("report version matches REPORT_FORMAT_VERSION constant", () => {
    const report = makeReport();
    expect(report.version).toBe(REPORT_FORMAT_VERSION);

    const wire = serializeReport(report);
    expect(wire.version).toBe(REPORT_FORMAT_VERSION);
  });

  it("holds all four event-count categories", () => {
    const report = makeReport();
    expect(report.eventCounts).toHaveProperty("rebalances");
    expect(report.eventCounts).toHaveProperty("deposits");
    expect(report.eventCounts).toHaveProperty("withdrawals");
    expect(report.eventCounts).toHaveProperty("priceFeedMisses");
  });
});
