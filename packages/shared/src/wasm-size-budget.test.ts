import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareWasmSizes,
  renderWasmSizeReport,
  wasmSizeBudgetManifestSchema,
  wasmSizeFailures,
} from "./wasm-size-budget";

const manifest: unknown = JSON.parse(
  readFileSync(
    new URL("../../contracts/wasm-size-budgets.json", import.meta.url),
    "utf8"
  )
);

describe("wasmSizeBudgetManifestSchema", () => {
  it("accepts the checked-in manifest", () => {
    const parsed = wasmSizeBudgetManifestSchema.parse(manifest);
    expect(Object.keys(parsed.budgets).length).toBeGreaterThan(0);
  });

  it("rejects non-integer, zero and negative budgets", () => {
    for (const bad of [1.5, 0, -1]) {
      expect(() =>
        wasmSizeBudgetManifestSchema.parse({ budgets: { vault: bad } })
      ).toThrow();
    }
  });

  it("rejects unknown top-level keys so typos are not silently ignored", () => {
    expect(() =>
      wasmSizeBudgetManifestSchema.parse({ budgets: {}, budget: {} })
    ).toThrow();
  });
});

describe("compareWasmSizes", () => {
  const budgets = { a: 1000, b: 2000 };

  it("passes when every contract is within budget, including exactly at it", () => {
    const rows = compareWasmSizes(budgets, { a: 1000, b: 1500 });
    expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(wasmSizeFailures(rows)).toEqual([]);
  });

  it("fails a contract one byte over its budget", () => {
    const rows = compareWasmSizes(budgets, { a: 1001, b: 1500 });
    expect(wasmSizeFailures(rows)).toEqual([
      expect.objectContaining({ contract: "a", status: "over-budget" }),
    ]);
  });

  it("fails a built contract that has no budget", () => {
    const rows = compareWasmSizes(budgets, { a: 10, b: 10, c: 10 });
    expect(wasmSizeFailures(rows).map((r) => [r.contract, r.status])).toEqual([
      ["c", "missing-budget"],
    ]);
  });

  it("fails a budgeted contract whose WASM was not built", () => {
    const rows = compareWasmSizes(budgets, { a: 10 });
    expect(wasmSizeFailures(rows).map((r) => [r.contract, r.status])).toEqual([
      ["b", "missing-wasm"],
    ]);
  });

  it("computes the delta from the base branch per contract", () => {
    const rows = compareWasmSizes(
      budgets,
      { a: 900, b: 1500, c: 5 },
      { a: 1000, b: 1500 }
    );
    expect(rows.map((r) => [r.contract, r.baseSize, r.delta])).toEqual([
      ["a", 1000, -100],
      ["b", 1500, 0],
      ["c", null, null],
    ]);
  });

  it("leaves the delta empty without a base build", () => {
    const rows = compareWasmSizes(budgets, { a: 900, b: 1500 });
    expect(rows.every((r) => r.delta === null && r.baseSize === null)).toBe(
      true
    );
  });
});

describe("renderWasmSizeReport", () => {
  it("shows size, budget, usage, signed delta and status per contract", () => {
    const rows = compareWasmSizes(
      { a: 2000, b: 1000, c: 10 },
      { a: 1500, b: 1200, d: 7 },
      { a: 1000, b: 1200 }
    );
    const report = renderWasmSizeReport(rows, "main");
    expect(report).toContain("Delta vs main");
    expect(report).toContain("| a | 1,500 | 2,000 | 75.0% | +500 | ok |");
    expect(report).toContain(
      "| b | 1,200 | 1,000 | 120.0% | 0 | OVER BUDGET |"
    );
    expect(report).toContain("| c | - | 10 | - | - | not built |");
    expect(report).toContain("| d | 7 | - | - | - | no budget |");
    expect(report).not.toContain("delta not shown");
  });

  it("shows a negative delta and notes when there is no base", () => {
    const shrunk = renderWasmSizeReport(
      compareWasmSizes({ a: 2000 }, { a: 900 }, { a: 1000 }),
      "main"
    );
    expect(shrunk).toContain("| -100 |");
    const noBase = renderWasmSizeReport(
      compareWasmSizes({ a: 2000 }, { a: 900 }),
      null
    );
    expect(noBase).toContain("Delta vs base");
    expect(noBase).toContain("delta not shown");
  });
});
