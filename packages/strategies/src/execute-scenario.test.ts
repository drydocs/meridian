import { afterEach, describe, expect, it, vi } from "vitest";
import { executeScenario } from "./execute-scenario";
import { scenarioClock } from "./regime-scenarios";
import { parseScenario } from "./scenario";
import type { Scenario } from "./scenario";
import type { HistoricalRow } from "./historical-loader";
import {
  BUY_AND_HOLD_ID,
  DELTA_NEUTRAL_ID,
  STRATEGY_VERSION_1,
} from "./registry";

const BASE_SCENARIO_INPUT = {
  schemaVersion: 1,
  window: {
    start: "2024-01-01T00:00:00Z",
    end: "2024-01-01T04:00:00Z",
    step: "PT1H",
  },
  assets: ["USDC"],
  source: {
    price: "horizon",
    rate: "blend",
  },
  startingCapital: "10000",
  strategy: {
    id: BUY_AND_HOLD_ID,
    version: STRATEGY_VERSION_1,
    params: { asset: "USDC" },
  },
  seed: "test-seed",
} as const;

function buildHistoricalRows(scenario: Scenario): HistoricalRow[] {
  const clock = scenarioClock(scenario);
  const rows: HistoricalRow[] = [];
  for (const asset of scenario.assets) {
    for (let i = 0; i <= clock.stepCount; i += 1) {
      rows.push({
        asset,
        timestamp: clock.timestampAt(i),
        price: (1 + i * 0.01).toFixed(4),
        kind: "price",
      });
    }
  }
  for (let i = 0; i <= clock.stepCount; i += 1) {
    rows.push({
      asset: scenario.source.rate,
      timestamp: clock.timestampAt(i),
      rate: "0.05",
      kind: "rate",
    });
  }
  return rows;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("executeScenario", () => {
  it("runs buy-and-hold end to end from unknown input and returns strategy, sources, and result", async () => {
    const scenario = parseScenario(BASE_SCENARIO_INPUT);
    const outcome = await executeScenario(BASE_SCENARIO_INPUT, {
      historicalData: buildHistoricalRows(scenario),
      defiLlamaPools: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.scenario).toEqual(scenario);
    expect(outcome.value.strategy.strategy.name).toBe(BUY_AND_HOLD_ID);
    expect(outcome.value.strategy.config).toEqual({ asset: "USDC" });
    expect(outcome.value.sources.prices).toBeDefined();
    expect(outcome.value.sources.accrual?.cashRateAnnual?.toString()).toBe(
      "0.05"
    );
    expect(outcome.value.result.strategyName).toBe(BUY_AND_HOLD_ID);
    expect(outcome.value.result.snapshots).toHaveLength(5);
    expect(outcome.value.result.initialCash.toString()).toBe("10000");
  });

  it("runs delta-neutral end to end from a validated Scenario", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      strategy: {
        id: DELTA_NEUTRAL_ID,
        version: STRATEGY_VERSION_1,
        params: {
          asset: "USDC",
          targetLeverage: "1",
          rebalanceBandBps: "100",
          fundingRatePerSecond: "0.000001",
        },
      },
    });

    const outcome = await executeScenario(scenario, {
      historicalData: buildHistoricalRows(scenario),
      defiLlamaPools: [],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.strategy.strategy.name).toBe(DELTA_NEUTRAL_ID);
    expect(outcome.value.result.strategyName).toBe(DELTA_NEUTRAL_ID);
    expect(outcome.value.result.snapshots).toHaveLength(5);
  });

  it("returns a typed validation error for invalid scenario input", async () => {
    const outcome = await executeScenario({
      ...BASE_SCENARIO_INPUT,
      startingCapital: "0",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.error.kind).toBe("validation");
    if (outcome.error.kind !== "validation") return;
    expect(outcome.error.fields["startingCapital"]).toContain(
      "startingCapital must be greater than zero"
    );
  });

  it("returns a typed unknown-strategy error for unknown version before resolving sources", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network should not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const outcome = await executeScenario({
      ...BASE_SCENARIO_INPUT,
      strategy: {
        ...BASE_SCENARIO_INPUT.strategy,
        version: "9.9.9",
      },
    });

    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: "unknown-strategy",
        message:
          "Unknown strategy 'buy-and-hold' version '9.9.9'. Available: buy-and-hold@1.0.0, delta-neutral@1.0.0.",
        strategyId: "buy-and-hold",
        strategyVersion: "9.9.9",
        available: ["buy-and-hold@1.0.0", "delta-neutral@1.0.0"],
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a typed unknown-strategy error for unknown strategy id", async () => {
    const outcome = await executeScenario({
      ...BASE_SCENARIO_INPUT,
      strategy: {
        ...BASE_SCENARIO_INPUT.strategy,
        id: "nonexistent",
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "unknown-strategy",
        strategyId: "nonexistent",
      },
    });
  });

  it("returns a typed source error when price data is missing without partial execution", async () => {
    const outcome = await executeScenario(BASE_SCENARIO_INPUT, {
      historicalData: [],
      defiLlamaPools: [],
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "source",
        asset: "USDC",
        source: "horizon",
      },
    });
  });

  it("returns a typed source error when rate data is missing without partial execution", async () => {
    const scenario = parseScenario(BASE_SCENARIO_INPUT);
    const priceOnlyRows = buildHistoricalRows(scenario).filter(
      (row) => row.kind === "price"
    );

    const outcome = await executeScenario(scenario, {
      historicalData: priceOnlyRows,
      defiLlamaPools: [],
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "source",
        asset: "USDC",
        source: "blend",
      },
    });
  });

  it("returns a typed strategy-params error when strategy asset is not in scenario assets", async () => {
    const scenario = parseScenario({
      ...BASE_SCENARIO_INPUT,
      strategy: {
        ...BASE_SCENARIO_INPUT.strategy,
        params: { asset: "EURC" },
      },
    });

    const outcome = await executeScenario(scenario, {
      historicalData: buildHistoricalRows(scenario),
      defiLlamaPools: [],
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        kind: "strategy-params",
        param: "asset",
      },
    });
  });

  it("makes no network requests when historical data is supplied", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network disabled in tests");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const scenario = parseScenario(BASE_SCENARIO_INPUT);
    const outcome = await executeScenario(scenario, {
      historicalData: buildHistoricalRows(scenario),
      defiLlamaPools: [],
    });

    expect(outcome.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("returns a root-level validation error for a non-object scenario", async () => {
    const outcome = await executeScenario(null);

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "validation" },
    });
  });

  it("returns a typed strategy-params error for an unknown strategy param", async () => {
    const scenario = parseScenario(BASE_SCENARIO_INPUT);
    const outcome = await executeScenario(
      {
        ...BASE_SCENARIO_INPUT,
        strategy: {
          ...BASE_SCENARIO_INPUT.strategy,
          params: { asset: "USDC", bogus: "1" },
        },
      },
      {
        historicalData: buildHistoricalRows(scenario),
        defiLlamaPools: [],
      }
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "strategy-params", param: "bogus" },
    });
  });

  it("returns an execution error for an unexpected failure", async () => {
    const scenario = parseScenario(BASE_SCENARIO_INPUT);
    const rows = buildHistoricalRows(scenario).map((row) =>
      row.kind === "price" ? { ...row, price: "not-a-number" } : row
    );
    const outcome = await executeScenario(scenario, {
      historicalData: rows,
      defiLlamaPools: [],
    });

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(["execution", "source"]).toContain(outcome.error.kind);
    }
  });

  it("uses a caller supplied clock instead of the scenario window", async () => {
    const scenario = parseScenario(BASE_SCENARIO_INPUT);
    const clock = scenarioClock(scenario);
    const outcome = await executeScenario(scenario, {
      clock,
      historicalData: buildHistoricalRows(scenario),
      defiLlamaPools: [],
    });

    expect(outcome.ok).toBe(true);
  });

  it("returns an execution error when reading the input throws", async () => {
    const hostile = {
      get schemaVersion(): never {
        throw new TypeError("hostile getter");
      },
    };
    const outcome = await executeScenario(hostile);

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "execution", message: "hostile getter" },
    });
  });

  it("describes a thrown non-error value as an execution error", async () => {
    const hostile = {
      get schemaVersion(): never {
        throw "plain string failure";
      },
    };
    const outcome = await executeScenario(hostile);

    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "execution", message: "plain string failure" },
    });
  });
});
