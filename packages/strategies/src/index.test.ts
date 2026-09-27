import { describe, it, expect, beforeEach } from "vitest";
import {
  FixedPointDecimal,
  StaticPriceFeed,
  BacktestPriceFeed,
  PriceFeed,
  UnknownAssetError,
  TimestampOutOfRangeError,
  AssetSymbol,
  SimulationTimestamp,
  isUnknownAssetError,
  isTimestampOutOfRangeError,
} from "./index";

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";

const BASE_TIMESTAMP: SimulationTimestamp = 1_700_000_000_000;

describe("FixedPointDecimal", () => {
  it("creates from string and preserves precision", () => {
    const price = FixedPointDecimal.fromString("1.0000001");
    expect(price.toString()).toBe("1.0000001");
    expect(price.toStroops()).toBe(10_000_001n);
  });

  it("creates from stroops and converts back", () => {
    const price = FixedPointDecimal.fromStroops(10_000_001n);
    expect(price.toString()).toBe("1.0000001");
  });

  it("handles whole numbers", () => {
    const price = FixedPointDecimal.fromString("100");
    expect(price.toString()).toBe("100");
    expect(price.toStroops()).toBe(1_000_000_000n);
  });

  it("handles negative values", () => {
    const price = FixedPointDecimal.fromString("-1.5");
    expect(price.toString()).toBe("-1.5");
    expect(price.toStroops()).toBe(-15_000_000n);
  });

  it("compares correctly", () => {
    const a = FixedPointDecimal.fromString("1.5");
    const b = FixedPointDecimal.fromString("1.5");
    const c = FixedPointDecimal.fromString("2.0");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.compareTo(c)).toBe(-1);
    expect(c.compareTo(a)).toBe(1);
    expect(a.compareTo(b)).toBe(0);
  });

  it("trailing zeros are trimmed in toString", () => {
    const price = FixedPointDecimal.fromString("1.5000000");
    expect(price.toString()).toBe("1.5");
  });
});

describe("StaticPriceFeed", () => {
  let feed: PriceFeed;

  beforeEach(() => {
    feed = StaticPriceFeed.create({
      USDC: "1.0000000",
      EURC: "1.0800000",
    });
  });

  it("returns correct price for known asset at any timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    expect(price.toString()).toBe("1");
    expect(price.toStroops()).toBe(10_000_000n);
  });

  it("returns different prices for different assets", () => {
    const usdcPrice = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    const eurcPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
    expect(usdcPrice.toString()).toBe("1");
    expect(eurcPrice.toString()).toBe("1.08");
    expect(usdcPrice.equals(eurcPrice)).toBe(false);
  });

  it("throws UnknownAssetError for unknown asset", () => {
    expect(() =>
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP)
    ).toThrow(UnknownAssetError);
    try {
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP);
    } catch (err) {
      expect(isUnknownAssetError(err)).toBe(true);
      if (isUnknownAssetError(err)) {
        expect(err.asset).toBe("BTC");
      }
    }
  });

  it("returns FixedPointDecimal instance, not a number", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    expect(price).toBeInstanceOf(FixedPointDecimal);
    expect(typeof price.toStroops()).toBe("bigint");
  });

  it("uses the same timestamp for all assets", () => {
    const price1 = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    const price2 = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 1000);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe("BacktestPriceFeed", () => {
  let feed: PriceFeed;

  beforeEach(() => {
    feed = BacktestPriceFeed.create({
      USDC: [
        { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
        { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
        { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
      ],
      EURC: [
        { timestamp: BASE_TIMESTAMP, price: "1.0800000" },
        { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0810000" },
      ],
    });
  });

  it("returns exact price at exact timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
    expect(price.toString()).toBe("1.0001");
  });

  it("returns latest price at or before requested timestamp (floor)", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 1800_000);
    expect(price.toString()).toBe("1");
  });

  it("returns different prices for different assets at same timestamp", () => {
    const usdcPrice = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    const eurcPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
    expect(usdcPrice.toString()).toBe("1");
    expect(eurcPrice.toString()).toBe("1.08");
  });

  it("throws UnknownAssetError for unknown asset", () => {
    expect(() =>
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP)
    ).toThrow(UnknownAssetError);
    try {
      feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP);
    } catch (err) {
      expect(isUnknownAssetError(err)).toBe(true);
    }
  });

  it("throws TimestampOutOfRangeError for timestamp before range", () => {
    expect(() => feed.getSpotPrice(USDC, BASE_TIMESTAMP - 1)).toThrow(
      TimestampOutOfRangeError
    );
    try {
      feed.getSpotPrice(USDC, BASE_TIMESTAMP - 1);
    } catch (err) {
      expect(isTimestampOutOfRangeError(err)).toBe(true);
      if (isTimestampOutOfRangeError(err)) {
        expect(err.timestamp).toBe(BASE_TIMESTAMP - 1);
        expect(err.minTimestamp).toBe(BASE_TIMESTAMP);
        expect(err.maxTimestamp).toBe(BASE_TIMESTAMP + 7200_000);
      }
    }
  });

  it("throws TimestampOutOfRangeError for timestamp after range", () => {
    expect(() =>
      feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000 + 1)
    ).toThrow(TimestampOutOfRangeError);
    try {
      feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000 + 1);
    } catch (err) {
      expect(isTimestampOutOfRangeError(err)).toBe(true);
      if (isTimestampOutOfRangeError(err)) {
        expect(err.timestamp).toBe(BASE_TIMESTAMP + 7200_000 + 1);
        expect(err.minTimestamp).toBe(BASE_TIMESTAMP);
        expect(err.maxTimestamp).toBe(BASE_TIMESTAMP + 7200_000);
      }
    }
  });

  it("succeeds at exactly the first valid timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
    expect(price.toString()).toBe("1");
  });

  it("succeeds at exactly the last valid timestamp", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000);
    expect(price.toString()).toBe("1.0002");
  });

  it("throws for asset with no data points", () => {
    const emptyFeed = BacktestPriceFeed.create({
      USDC: [],
      EURC: [],
    });
    expect(() => emptyFeed.getSpotPrice(USDC, BASE_TIMESTAMP)).toThrow(
      UnknownAssetError
    );
  });

  it("returns FixedPointDecimal instance with correct precision", () => {
    const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
    expect(price).toBeInstanceOf(FixedPointDecimal);
    expect(price.toStroops()).toBe(10_001_000n);
  });

  it("sorts data points by timestamp internally", () => {
    const unsortedFeed = BacktestPriceFeed.create({
      USDC: [
        { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
        { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
        { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
      ],
      EURC: [],
    });
    const price = unsortedFeed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
    expect(price.toString()).toBe("1.0001");
  });
});

describe("PriceFeed contract tests - multiple implementations", () => {
  function runBaseContractTests(feed: PriceFeed, name: string) {
    describe(`${name} base contract`, () => {
      it("known asset + valid timestamp returns FixedPointDecimal", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
        expect(price).toBeInstanceOf(FixedPointDecimal);
        expect(price.toStroops()).toBe(10_000_000n);
      });

      it("two assets return their own prices correctly", () => {
        const usdcPrice = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
        const eurcPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
        expect(usdcPrice.toString()).toBe("1");
        expect(eurcPrice.toString()).toBe("1.08");
        expect(usdcPrice.equals(eurcPrice)).toBe(false);
      });

      it("unknown asset throws UnknownAssetError", () => {
        expect(() =>
          feed.getSpotPrice("BTC" as AssetSymbol, BASE_TIMESTAMP)
        ).toThrow(UnknownAssetError);
      });
    });
  }

  function runTimeRangeContractTests(feed: PriceFeed, name: string) {
    describe(`${name} time-range contract`, () => {
      it("timestamp before range fails with TimestampOutOfRangeError", () => {
        expect(() => feed.getSpotPrice(USDC, BASE_TIMESTAMP - 1)).toThrow(
          TimestampOutOfRangeError
        );
      });

      it("timestamp after range fails with TimestampOutOfRangeError", () => {
        expect(() =>
          feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000 + 1)
        ).toThrow(TimestampOutOfRangeError);
      });

      it("exactly first valid timestamp succeeds", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP);
        expect(price.toString()).toBe("1");
      });

      it("exactly last valid timestamp succeeds", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 7200_000);
        expect(price.toString()).toBe("1.0002");
      });

      it("decimal precision is preserved exactly", () => {
        const price = feed.getSpotPrice(USDC, BASE_TIMESTAMP + 3600_000);
        expect(price.toStroops()).toBe(10_001_000n);
      });
    });
  }

  const staticFeed = StaticPriceFeed.create({
    USDC: "1.0000000",
    EURC: "1.0800000",
  });

  const backtestFeed = BacktestPriceFeed.create({
    USDC: [
      { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
      { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
      { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
    ],
    EURC: [
      { timestamp: BASE_TIMESTAMP, price: "1.0800000" },
      { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0810000" },
    ],
  });

  runBaseContractTests(staticFeed, "StaticPriceFeed");
  runBaseContractTests(backtestFeed, "BacktestPriceFeed");
  runTimeRangeContractTests(backtestFeed, "BacktestPriceFeed");

  it("strategy compiles and executes against both implementations without changes", () => {
    function strategy(
      feed: PriceFeed,
      asset: AssetSymbol,
      timestamp: SimulationTimestamp
    ): FixedPointDecimal {
      return feed.getSpotPrice(asset, timestamp);
    }

    const staticResult = strategy(staticFeed, USDC, BASE_TIMESTAMP);
    const backtestResult = strategy(backtestFeed, USDC, BASE_TIMESTAMP);

    expect(staticResult.toString()).toBe("1");
    expect(backtestResult.toString()).toBe("1");
    expect(staticResult.equals(backtestResult)).toBe(true);
  });
});

describe("Error type guards", () => {
  it("isUnknownAssetError identifies UnknownAssetError", () => {
    const err = new UnknownAssetError("BTC" as AssetSymbol);
    expect(isUnknownAssetError(err)).toBe(true);
    expect(isUnknownAssetError(new Error())).toBe(false);
    expect(isUnknownAssetError("string")).toBe(false);
  });

  it("isTimestampOutOfRangeError identifies TimestampOutOfRangeError", () => {
    const err = new TimestampOutOfRangeError(
      BASE_TIMESTAMP,
      BASE_TIMESTAMP,
      BASE_TIMESTAMP + 1000
    );
    expect(isTimestampOutOfRangeError(err)).toBe(true);
    expect(isTimestampOutOfRangeError(new Error())).toBe(false);
    expect(isTimestampOutOfRangeError("string")).toBe(false);
  });
});

import {
  RunReport,
  RunScenario,
  RiskMetrics,
  EventCounts,
  FinalPortfolioState,
  serializeRunReport,
  deserializeRunReport,
  runReportToJSON,
  runReportFromJSON,
  SerializedRunReport,
  CURRENT_REPORT_VERSION,
  UnknownReportVersionError,
  isUnknownReportVersionError,
  buildWarmStartContext,
  validateWarmStart,
  WarmStartScenarioMismatchError,
  isWarmStartScenarioMismatchError,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(overrides?: Partial<RunReport>): RunReport {
  const scenario: RunScenario = {
    label: "USDC bull 2024-Q1",
    startTimestamp: BASE_TIMESTAMP,
    endTimestamp: BASE_TIMESTAMP + 7200_000,
    assets: ["USDC", "EURC"],
  };

  const riskMetrics: RiskMetrics = {
    maxDrawdown: FixedPointDecimal.fromString("0.0523456"),
    sharpeRatio: FixedPointDecimal.fromString("1.2345678"),
    annualisedVolatility: FixedPointDecimal.fromString("0.1234567"),
    totalReturn: FixedPointDecimal.fromString("0.0987654"),
  };

  const eventCounts: EventCounts = {
    rebalances: 3,
    priceTicks: 72,
    stopLossTriggers: 1,
    takeProfitTriggers: 0,
  };

  const finalState: FinalPortfolioState = {
    timestamp: BASE_TIMESTAMP + 7200_000,
    positions: [
      {
        asset: "USDC",
        quantity: FixedPointDecimal.fromString("500.0000001"),
        lastPrice: FixedPointDecimal.fromString("1.0002000"),
      },
      {
        asset: "EURC",
        quantity: FixedPointDecimal.fromString("200.5000000"),
        lastPrice: FixedPointDecimal.fromString("1.0810000"),
      },
    ],
    totalValue: FixedPointDecimal.fromString("716.7202001"),
  };

  return {
    version: CURRENT_REPORT_VERSION,
    scenario,
    riskMetrics,
    eventCounts,
    finalState,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RunReport round-trip fidelity
// ---------------------------------------------------------------------------

describe("RunReport serialization round-trip", () => {
  it("serializeRunReport / deserializeRunReport preserves all FixedPointDecimal values exactly", () => {
    const original = makeReport();
    const roundTripped = deserializeRunReport(serializeRunReport(original));

    expect(roundTripped.riskMetrics.maxDrawdown.toStroops()).toBe(
      original.riskMetrics.maxDrawdown.toStroops()
    );
    expect(roundTripped.riskMetrics.sharpeRatio.toStroops()).toBe(
      original.riskMetrics.sharpeRatio.toStroops()
    );
    expect(roundTripped.riskMetrics.annualisedVolatility.toStroops()).toBe(
      original.riskMetrics.annualisedVolatility.toStroops()
    );
    expect(roundTripped.riskMetrics.totalReturn.toStroops()).toBe(
      original.riskMetrics.totalReturn.toStroops()
    );
    expect(roundTripped.finalState.totalValue.toStroops()).toBe(
      original.finalState.totalValue.toStroops()
    );

    for (let i = 0; i < original.finalState.positions.length; i++) {
      const orig = original.finalState.positions[i]!;
      const rt = roundTripped.finalState.positions[i]!;
      expect(rt.asset).toBe(orig.asset);
      expect(rt.quantity.toStroops()).toBe(orig.quantity.toStroops());
      expect(rt.lastPrice.toStroops()).toBe(orig.lastPrice.toStroops());
    }
  });

  it("round-trip preserves scenario and event counts exactly", () => {
    const original = makeReport();
    const roundTripped = deserializeRunReport(serializeRunReport(original));

    expect(roundTripped.scenario.label).toBe(original.scenario.label);
    expect(roundTripped.scenario.startTimestamp).toBe(
      original.scenario.startTimestamp
    );
    expect(roundTripped.scenario.endTimestamp).toBe(
      original.scenario.endTimestamp
    );
    expect(roundTripped.scenario.assets).toEqual(original.scenario.assets);

    expect(roundTripped.eventCounts.rebalances).toBe(
      original.eventCounts.rebalances
    );
    expect(roundTripped.eventCounts.priceTicks).toBe(
      original.eventCounts.priceTicks
    );
    expect(roundTripped.eventCounts.stopLossTriggers).toBe(
      original.eventCounts.stopLossTriggers
    );
    expect(roundTripped.eventCounts.takeProfitTriggers).toBe(
      original.eventCounts.takeProfitTriggers
    );
    expect(roundTripped.finalState.timestamp).toBe(
      original.finalState.timestamp
    );
  });

  it("serialized form stores FixedPointDecimal fields as strings", () => {
    const serialized = serializeRunReport(makeReport());

    expect(typeof serialized.riskMetrics.maxDrawdown).toBe("string");
    expect(typeof serialized.riskMetrics.sharpeRatio).toBe("string");
    expect(typeof serialized.riskMetrics.annualisedVolatility).toBe("string");
    expect(typeof serialized.riskMetrics.totalReturn).toBe("string");
    expect(typeof serialized.finalState.totalValue).toBe("string");

    for (const p of serialized.finalState.positions) {
      expect(typeof p.quantity).toBe("string");
      expect(typeof p.lastPrice).toBe("string");
    }
  });

  it("no precision loss through JSON stringify / parse", () => {
    const original = makeReport();
    const json = runReportToJSON(original);
    const restored = runReportFromJSON(json);

    expect(restored.riskMetrics.maxDrawdown.toStroops()).toBe(
      original.riskMetrics.maxDrawdown.toStroops()
    );
    expect(restored.finalState.totalValue.toStroops()).toBe(
      original.finalState.totalValue.toStroops()
    );

    for (let i = 0; i < original.finalState.positions.length; i++) {
      const orig = original.finalState.positions[i]!;
      const rt = restored.finalState.positions[i]!;
      expect(rt.quantity.toStroops()).toBe(orig.quantity.toStroops());
      expect(rt.lastPrice.toStroops()).toBe(orig.lastPrice.toStroops());
    }
  });

  it("serialized strings round-trip for extreme precision values (7 decimal places)", () => {
    const original = makeReport();
    original.riskMetrics.maxDrawdown = FixedPointDecimal.fromString(
      "0.0000001"
    );
    original.finalState.totalValue = FixedPointDecimal.fromString(
      "9999999.9999999"
    );

    const roundTripped = deserializeRunReport(serializeRunReport(original));
    expect(roundTripped.riskMetrics.maxDrawdown.toStroops()).toBe(1n);
    expect(roundTripped.finalState.totalValue.toStroops()).toBe(
      99_999_999_999_999n
    );
  });

  it("report carries version field", () => {
    const report = makeReport();
    expect(report.version).toBe(CURRENT_REPORT_VERSION);
    const serialized = serializeRunReport(report);
    expect(serialized.version).toBe(CURRENT_REPORT_VERSION);
    const restored = deserializeRunReport(serialized);
    expect(restored.version).toBe(CURRENT_REPORT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Version checking
// ---------------------------------------------------------------------------

describe("RunReport version handling", () => {
  it("deserializeRunReport succeeds for the current version", () => {
    const serialized = serializeRunReport(makeReport());
    expect(() => deserializeRunReport(serialized)).not.toThrow();
  });

  it("deserializeRunReport throws UnknownReportVersionError for unknown versions", () => {
    const future = {
      ...serializeRunReport(makeReport()),
      version: CURRENT_REPORT_VERSION + 1,
    } as SerializedRunReport;

    expect(() => deserializeRunReport(future)).toThrow(
      UnknownReportVersionError
    );
  });

  it("error message contains both the found and expected version numbers", () => {
    const badVersion = CURRENT_REPORT_VERSION + 99;
    const future = {
      ...serializeRunReport(makeReport()),
      version: badVersion,
    } as SerializedRunReport;

    try {
      deserializeRunReport(future);
      expect.fail("should have thrown");
    } catch (err) {
      expect(isUnknownReportVersionError(err)).toBe(true);
      if (isUnknownReportVersionError(err)) {
        expect(err.found).toBe(badVersion);
        expect(err.expected).toBe(CURRENT_REPORT_VERSION);
        expect(err.message).toContain(String(badVersion));
        expect(err.message).toContain(String(CURRENT_REPORT_VERSION));
      }
    }
  });

  it("version 0 is rejected loudly", () => {
    const stale = {
      ...serializeRunReport(makeReport()),
      version: 0,
    } as SerializedRunReport;

    expect(() => deserializeRunReport(stale)).toThrow(UnknownReportVersionError);
  });

  it("runReportFromJSON rejects unknown version in JSON string", () => {
    const json = JSON.stringify({
      ...serializeRunReport(makeReport()),
      version: 999,
    });
    expect(() => runReportFromJSON(json)).toThrow(UnknownReportVersionError);
  });
});

// ---------------------------------------------------------------------------
// Warm-start
// ---------------------------------------------------------------------------

describe("RunReport warm-start", () => {
  it("buildWarmStartContext extracts resumeTimestamp from finalState", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);
    expect(ctx.resumeTimestamp).toBe(report.finalState.timestamp);
  });

  it("buildWarmStartContext preserves positions with exact stroops", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    expect(ctx.positions.length).toBe(report.finalState.positions.length);
    for (let i = 0; i < ctx.positions.length; i++) {
      const orig = report.finalState.positions[i]!;
      const warm = ctx.positions[i]!;
      expect(warm.asset).toBe(orig.asset);
      expect(warm.quantity.toStroops()).toBe(orig.quantity.toStroops());
      expect(warm.lastPrice.toStroops()).toBe(orig.lastPrice.toStroops());
    }
  });

  it("buildWarmStartContext preserves totalValue exactly", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);
    expect(ctx.totalValue.toStroops()).toBe(
      report.finalState.totalValue.toStroops()
    );
  });

  it("buildWarmStartContext copies originalScenario", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);
    expect(ctx.originalScenario.label).toBe(report.scenario.label);
    expect(ctx.originalScenario.startTimestamp).toBe(
      report.scenario.startTimestamp
    );
    expect(ctx.originalScenario.endTimestamp).toBe(
      report.scenario.endTimestamp
    );
    expect(ctx.originalScenario.assets).toEqual(report.scenario.assets);
  });

  it("validateWarmStart accepts a valid contiguous extension scenario", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    const extensionScenario: RunScenario = {
      label: "USDC bull 2024-Q1 extension",
      startTimestamp: report.finalState.timestamp + 1,
      endTimestamp: report.finalState.timestamp + 3600_000,
      assets: ["USDC", "EURC"],
    };

    expect(() => validateWarmStart(ctx, extensionScenario)).not.toThrow();
  });

  it("validateWarmStart accepts extension with a subset of original assets", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    const extensionScenario: RunScenario = {
      label: "USDC only extension",
      startTimestamp: report.finalState.timestamp + 1,
      endTimestamp: report.finalState.timestamp + 3600_000,
      assets: ["USDC"], // subset of ["USDC", "EURC"]
    };

    expect(() => validateWarmStart(ctx, extensionScenario)).not.toThrow();
  });

  it("validateWarmStart rejects extension that introduces a new asset", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    // "BTC" is not in the original assets array
    const extensionScenario: RunScenario = {
      label: "with new asset",
      startTimestamp: report.finalState.timestamp + 1,
      endTimestamp: report.finalState.timestamp + 3600_000,
      assets: ["USDC", "EURC", "BTC" as AssetSymbol],
    };

    expect(() => validateWarmStart(ctx, extensionScenario)).toThrow(
      WarmStartScenarioMismatchError
    );
  });

  it("validateWarmStart rejects extension whose start overlaps with the original window", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    const overlappingScenario: RunScenario = {
      label: "overlapping",
      // startTimestamp === resumeTimestamp: not strictly after
      startTimestamp: report.finalState.timestamp,
      endTimestamp: report.finalState.timestamp + 3600_000,
      assets: ["USDC"],
    };

    expect(() => validateWarmStart(ctx, overlappingScenario)).toThrow(
      WarmStartScenarioMismatchError
    );
  });

  it("validateWarmStart rejects extension that starts before the resume timestamp", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    const backwardsScenario: RunScenario = {
      label: "backwards",
      startTimestamp: report.finalState.timestamp - 1000,
      endTimestamp: report.finalState.timestamp + 3600_000,
      assets: ["USDC"],
    };

    expect(() => validateWarmStart(ctx, backwardsScenario)).toThrow(
      WarmStartScenarioMismatchError
    );
  });

  it("error message from WarmStartScenarioMismatchError contains helpful context", () => {
    const report = makeReport();
    const ctx = buildWarmStartContext(report);

    const badScenario: RunScenario = {
      label: "bad",
      startTimestamp: report.finalState.timestamp,
      endTimestamp: report.finalState.timestamp + 3600_000,
      assets: ["USDC"],
    };

    try {
      validateWarmStart(ctx, badScenario);
      expect.fail("should have thrown");
    } catch (err) {
      expect(isWarmStartScenarioMismatchError(err)).toBe(true);
      if (isWarmStartScenarioMismatchError(err)) {
        expect(err.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("warm-start equivalence: warm-started run over [T1,T2] matches an uninterrupted run over [T0,T2] at T2", () => {
    // This test simulates a simple summation strategy to verify that
    // seeding state from a saved report's finalState and running from T1→T2
    // yields the same total as running T0→T2 uninterrupted.

    // Tick prices for USDC at each timestamp
    const ticks: Array<{ timestamp: SimulationTimestamp; price: string }> = [
      { timestamp: BASE_TIMESTAMP, price: "1.0000000" },
      { timestamp: BASE_TIMESTAMP + 3600_000, price: "1.0001000" },
      { timestamp: BASE_TIMESTAMP + 7200_000, price: "1.0002000" },
    ];

    type RunState = { totalValue: FixedPointDecimal; priceTicks: number };

    // A trivial strategy: total value accumulates the USDC price at each tick
    // multiplied by a fixed holding of 100 USDC.
    function runTicks(
      from: SimulationTimestamp,
      to: SimulationTimestamp,
      seedValue: FixedPointDecimal,
      seedTicks: number
    ): RunState {
      let acc = seedValue.toStroops();
      let tickCount = seedTicks;
      const holding = FixedPointDecimal.fromString("100").toStroops();
      for (const tick of ticks) {
        if (tick.timestamp > from && tick.timestamp <= to) {
          acc += FixedPointDecimal.fromString(tick.price).toStroops() * holding / 10_000_000n;
          tickCount++;
        }
      }
      return {
        totalValue: FixedPointDecimal.fromStroops(acc),
        priceTicks: tickCount,
      };
    }

    const T0 = BASE_TIMESTAMP;
    const T1 = BASE_TIMESTAMP + 3600_000;
    const T2 = BASE_TIMESTAMP + 7200_000;
    const ZERO = FixedPointDecimal.fromString("0");

    // --- Uninterrupted run T0→T2 ---
    const full = runTicks(T0 - 1, T2, ZERO, 0);

    // --- Two-segment run: T0→T1, then warm-start T1→T2 ---
    const firstLeg = runTicks(T0 - 1, T1, ZERO, 0);

    // Build and round-trip a report for the first leg
    const firstReport: RunReport = {
      version: CURRENT_REPORT_VERSION,
      scenario: {
        label: "first leg",
        startTimestamp: T0,
        endTimestamp: T1,
        assets: ["USDC"],
      },
      riskMetrics: {
        maxDrawdown: ZERO,
        sharpeRatio: ZERO,
        annualisedVolatility: ZERO,
        totalReturn: ZERO,
      },
      eventCounts: {
        rebalances: 0,
        priceTicks: firstLeg.priceTicks,
        stopLossTriggers: 0,
        takeProfitTriggers: 0,
      },
      finalState: {
        timestamp: T1,
        positions: [
          {
            asset: "USDC",
            quantity: FixedPointDecimal.fromString("100"),
            lastPrice: FixedPointDecimal.fromString("1.0001000"),
          },
        ],
        totalValue: firstLeg.totalValue,
      },
    };

    // Round-trip the report to simulate persistence
    const restoredReport = runReportFromJSON(runReportToJSON(firstReport));
    const ctx = buildWarmStartContext(restoredReport);

    // Validate the extension before consuming the context
    const extensionScenario: RunScenario = {
      label: "second leg",
      startTimestamp: T1 + 1,
      endTimestamp: T2,
      assets: ["USDC"],
    };
    expect(() => validateWarmStart(ctx, extensionScenario)).not.toThrow();

    // Resume from where the first leg ended
    const secondLeg = runTicks(
      ctx.resumeTimestamp,
      T2,
      ctx.totalValue,
      firstLeg.priceTicks
    );

    // The warm-started result must equal the uninterrupted run
    expect(secondLeg.totalValue.toStroops()).toBe(full.totalValue.toStroops());
    expect(secondLeg.priceTicks).toBe(full.priceTicks);
  });
});
