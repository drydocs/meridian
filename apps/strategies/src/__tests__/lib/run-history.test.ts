import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedPointDecimal, buildRegimeScenario } from "@meridian/strategies";
import type { BacktestSnapshot } from "@meridian/strategies";
import {
  MAX_RUN_HISTORY,
  RUN_HISTORY_STORAGE_KEY,
  createRunRecord,
  deleteRunHistoryRecord,
  loadRunHistory,
  saveRunHistory,
} from "../../lib/run-history";
import type { ScenarioRun } from "../../lib/scenario-run";

function makeRun(value: string): ScenarioRun {
  const decimal = FixedPointDecimal.fromString(value);
  const initialCash = FixedPointDecimal.fromString("100");
  const snapshots: BacktestSnapshot[] = [
    {
      index: 0,
      timestamp: Date.UTC(2025, 0, 1),
      cash: initialCash,
      positions: [],
      value: initialCash,
    },
    {
      index: 1,
      timestamp: Date.UTC(2025, 0, 2),
      cash: decimal,
      positions: [],
      value: decimal,
    },
  ];
  return {
    scenario: buildRegimeScenario("trending"),
    market: {
      regime: "trending",
      startPrice: "1",
      drift: "0",
      volatility: "0",
      cashRateAnnual: "0.05",
    },
    result: {
      strategyName: "buy-and-hold",
      initialCash,
      snapshots,
      finalValue: decimal,
      strategyEquity: decimal,
      totalInterest: FixedPointDecimal.fromString("0"),
      totalFunding: FixedPointDecimal.fromString("0"),
      totalFees: FixedPointDecimal.fromString("0"),
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("run history storage", () => {
  it("saves and restores scenarios, result decimals, snapshots, and risk metrics", () => {
    const record = createRunRecord(
      makeRun("110"),
      new Date("2025-01-03T00:00:00.000Z")
    );
    saveRunHistory([record]);

    const loaded = loadRunHistory();

    expect(loaded.dropped).toBe(false);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]?.scenario.strategy.id).toBe(
      record.scenario.strategy.id
    );
    expect(loaded.records[0]?.result.finalValue.toString()).toBe("110");
    expect(loaded.records[0]?.result.snapshots[1]?.value.toString()).toBe(
      "110"
    );
    expect(loaded.records[0]?.riskMetrics.maxDrawdown).toMatch(/^0(?:\.0+)?$/);
  });

  it("evicts the oldest run when the store exceeds its cap", () => {
    const records = Array.from({ length: MAX_RUN_HISTORY + 1 }, (_, index) =>
      createRunRecord(
        makeRun(String(index + 1)),
        new Date(Date.UTC(2025, 0, 1) + index * 1000)
      )
    );
    const saved = saveRunHistory(records);

    expect(saved).toHaveLength(MAX_RUN_HISTORY);
    expect(saved.some((record) => record.id === records[0]?.id)).toBe(false);
    expect(loadRunHistory().records[0]?.id).toBe(
      records[records.length - 1]?.id
    );
  });

  it("skips corrupted and unknown-version records without losing valid runs", () => {
    const valid = createRunRecord(makeRun("110"));
    saveRunHistory([valid]);
    const stored = JSON.parse(
      localStorage.getItem(RUN_HISTORY_STORAGE_KEY) ?? "{}"
    ) as { version: number; records: unknown[] };
    const storedRecord = stored.records[0] as Record<string, unknown>;
    stored.records.push(
      { ...storedRecord, version: 99 },
      { ...storedRecord, result: { snapshots: "not json" } }
    );
    localStorage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify(stored));

    const loaded = loadRunHistory();

    expect(loaded.dropped).toBe(true);
    expect(loaded.records.map((record) => record.id)).toEqual([valid.id]);
    // Unreadable records stay in storage; a load never rewrites them.
    expect(
      JSON.parse(localStorage.getItem(RUN_HISTORY_STORAGE_KEY) ?? "{}").records
    ).toHaveLength(3);
  });

  it("leaves unreadable stored data in place", () => {
    const unreadable = JSON.stringify({ version: 2, records: [{ id: "x" }] });
    localStorage.setItem(RUN_HISTORY_STORAGE_KEY, unreadable);
    expect(loadRunHistory()).toEqual({ records: [], dropped: true });
    expect(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBe(unreadable);

    localStorage.setItem(RUN_HISTORY_STORAGE_KEY, "{not json");
    expect(loadRunHistory()).toEqual({ records: [], dropped: true });
    expect(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBe("{not json");
  });

  it("keeps records from a newer build when it saves", () => {
    const valid = createRunRecord(makeRun("110"));
    saveRunHistory([valid]);
    const stored = JSON.parse(
      localStorage.getItem(RUN_HISTORY_STORAGE_KEY) ?? "{}"
    ) as { version: number; records: unknown[] };
    stored.records.push({ id: "from-newer-build", version: 2 });
    localStorage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify(stored));

    saveRunHistory([valid, createRunRecord(makeRun("120"))]);

    const after = JSON.parse(
      localStorage.getItem(RUN_HISTORY_STORAGE_KEY) ?? "{}"
    ) as { records: { id: string }[] };
    expect(
      after.records.some((record) => record.id === "from-newer-build")
    ).toBe(true);
  });

  it("evicts the oldest runs and keeps the newest when storage is full", () => {
    const records = Array.from({ length: 4 }, (_, index) =>
      createRunRecord(
        makeRun(String(index + 1)),
        new Date(Date.UTC(2025, 0, 1) + index * 1000)
      )
    );
    const real = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if ((JSON.parse(value) as { records: unknown[] }).records.length > 2) {
          throw new DOMException("full", "QuotaExceededError");
        }
        real.call(this, key, value);
      });

    const saved = saveRunHistory(records);
    setItem.mockRestore();

    expect(saved.map((record) => record.id)).toEqual([
      records[3]?.id,
      records[2]?.id,
    ]);
    expect(loadRunHistory().records.map((record) => record.id)).toEqual([
      records[3]?.id,
      records[2]?.id,
    ]);
  });

  it("does not throw when even one run does not fit", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });

    expect(saveRunHistory([createRunRecord(makeRun("110"))])).toEqual([]);
    setItem.mockRestore();
  });

  it("rethrows errors that are not quota errors", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });

    expect(() => saveRunHistory([createRunRecord(makeRun("110"))])).toThrow(
      "denied"
    );
    setItem.mockRestore();
  });

  it("deletes a run and persists the remaining history", () => {
    const first = createRunRecord(makeRun("110"));
    const second = createRunRecord(makeRun("120"));
    const records = saveRunHistory([first, second]);

    const remaining = deleteRunHistoryRecord(records, first.id);

    expect(remaining.map((record) => record.id)).toEqual([second.id]);
    expect(loadRunHistory().records.map((record) => record.id)).toEqual([
      second.id,
    ]);
  });
});
