import { describe, expect, it } from "vitest";
import { FixedPointDecimal } from "@meridian/strategies";
import type { BacktestResult, Scenario } from "@meridian/strategies";
import {
  RUN_HISTORY_LIMIT,
  RUN_HISTORY_STORAGE_KEY,
  clearRunHistory,
  createRunRecord,
  deleteRunRecord,
  loadRunHistory,
  saveRunRecord,
} from "./run-history";
import type { RunHistoryStorage } from "./run-history";

class MemoryStorage implements RunHistoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const scenario: Scenario = {
  schemaVersion: 1,
  window: {
    start: "2025-01-01T00:00:00Z",
    end: "2025-01-02T00:00:00Z",
    step: "PT1H",
  },
  assets: ["USDC"],
  source: { price: "horizon", rate: "blend" },
  startingCapital: "100",
  strategy: { id: "test-strategy", version: "1", params: {} },
  seed: "history-test",
};

function result(finalValue = "110"): BacktestResult {
  const initialCash = FixedPointDecimal.fromString("100");
  return {
    strategyName: "Test strategy",
    initialCash,
    snapshots: [
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
        cash: FixedPointDecimal.fromString(finalValue),
        positions: [],
        value: FixedPointDecimal.fromString(finalValue),
      },
    ],
    finalValue: FixedPointDecimal.fromString(finalValue),
    strategyEquity: FixedPointDecimal.fromString(finalValue),
    totalInterest: FixedPointDecimal.fromString("0"),
    totalFunding: FixedPointDecimal.fromString("0"),
    totalFees: FixedPointDecimal.fromString("0"),
  };
}

describe("run history", () => {
  it("saves and loads a run with fixed-point values intact", () => {
    const storage = new MemoryStorage();
    const record = createRunRecord(scenario, result(), {
      id: "saved-run",
      createdAt: Date.UTC(2025, 0, 2),
    });

    saveRunRecord(record, storage);
    const loaded = loadRunHistory(storage);

    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]?.result.finalValue.toString()).toBe("110");
    expect(loaded.records[0]?.scenario.strategy.id).toBe("test-strategy");
    expect(loaded.records[0]?.riskMetrics.maxDrawdown.toString()).toBe(
      "0.000000000000000000"
    );
    expect(loaded.droppedCount).toBe(0);
  });

  it("evicts the oldest run when the store reaches its cap", () => {
    const storage = new MemoryStorage();

    for (let index = 0; index <= RUN_HISTORY_LIMIT; index += 1) {
      saveRunRecord(
        createRunRecord(scenario, result(), {
          id: `run-${index}`,
          createdAt: index,
        }),
        storage
      );
    }

    const loaded = loadRunHistory(storage);
    expect(loaded.records).toHaveLength(RUN_HISTORY_LIMIT);
    expect(loaded.records[0]?.id).toBe(`run-${RUN_HISTORY_LIMIT}`);
    expect(loaded.records.some((record) => record.id === "run-0")).toBe(false);
  });

  it("drops corrupted records without discarding valid runs", () => {
    const storage = new MemoryStorage();
    saveRunRecord(
      createRunRecord(scenario, result(), { id: "valid-run", createdAt: 1 }),
      storage
    );
    const persisted = JSON.parse(
      storage.getItem(RUN_HISTORY_STORAGE_KEY) ?? "{}"
    ) as { version: number; records: unknown[] };
    persisted.records.push({ version: 99, id: "unknown-version" });
    persisted.records.push({
      version: 1,
      id: "corrupted",
      createdAt: "not-a-timestamp",
    });
    storage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify(persisted));

    const loaded = loadRunHistory(storage);

    expect(loaded.records.map((record) => record.id)).toEqual(["valid-run"]);
    expect(loaded.droppedCount).toBe(2);
  });

  it("deletes a single run without affecting the others", () => {
    const storage = new MemoryStorage();
    saveRunRecord(
      createRunRecord(scenario, result(), { id: "keep", createdAt: 2 }),
      storage
    );
    saveRunRecord(
      createRunRecord(scenario, result(), { id: "remove", createdAt: 1 }),
      storage
    );

    const remaining = deleteRunRecord("remove", storage);

    expect(remaining.records.map((record) => record.id)).toEqual(["keep"]);
    expect(loadRunHistory(storage).records.map((record) => record.id)).toEqual([
      "keep",
    ]);
  });

  it("clears the history store", () => {
    const storage = new MemoryStorage();
    saveRunRecord(
      createRunRecord(scenario, result(), { id: "clear-me", createdAt: 1 }),
      storage
    );

    clearRunHistory(storage);

    expect(loadRunHistory(storage).records).toEqual([]);
    expect(storage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
  });
});
