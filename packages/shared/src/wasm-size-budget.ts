import { z } from "zod";

/**
 * Per-contract WASM size budgets (#1353).
 *
 * The manifest lives at `packages/contracts/wasm-size-budgets.json` and maps
 * each contract's release WASM file stem (e.g. `meridian_vault`) to the
 * largest size in bytes it may reach. `scripts/check-wasm-size.ts` measures
 * the build, compares it with these budgets and with the base branch, and
 * fails CI when a contract is over budget.
 */
export const wasmSizeBudgetManifestSchema = z
  .object({
    $comment: z.string().optional(),
    budgets: z.record(z.string().min(1), z.number().int().positive()),
  })
  .strict();

export type WasmSizeBudgetManifest = z.infer<
  typeof wasmSizeBudgetManifestSchema
>;

export type WasmSizeStatus =
  "ok" | "over-budget" | "missing-budget" | "missing-wasm";

export interface WasmSizeRow {
  contract: string;
  /** Size of the current build in bytes; null when the WASM was not built. */
  size: number | null;
  budget: number | null;
  /** Size in the base branch build; null when unknown or absent there. */
  baseSize: number | null;
  /** `size - baseSize`; null when either side is unknown. */
  delta: number | null;
  status: WasmSizeStatus;
}

/**
 * Compares measured sizes with the budgets and (optionally) the base branch.
 *
 * Every built contract must have a budget, and every budgeted contract must
 * have been built: a new contract without a budget, or a stale budget for a
 * contract that no longer builds, fails the check just like growth does.
 */
export function compareWasmSizes(
  budgets: Record<string, number>,
  sizes: Record<string, number>,
  baseSizes: Record<string, number> | null = null
): WasmSizeRow[] {
  const names = [
    ...new Set([...Object.keys(budgets), ...Object.keys(sizes)]),
  ].sort();
  return names.map((contract) => {
    const size = sizes[contract] ?? null;
    const budget = budgets[contract] ?? null;
    const baseSize = baseSizes?.[contract] ?? null;
    const delta = size !== null && baseSize !== null ? size - baseSize : null;
    let status: WasmSizeStatus = "ok";
    if (size === null) status = "missing-wasm";
    else if (budget === null) status = "missing-budget";
    else if (size > budget) status = "over-budget";
    return { contract, size, budget, baseSize, delta, status };
  });
}

export function wasmSizeFailures(rows: WasmSizeRow[]): WasmSizeRow[] {
  return rows.filter((row) => row.status !== "ok");
}

const STATUS_LABEL: Record<WasmSizeStatus, string> = {
  ok: "ok",
  "over-budget": "OVER BUDGET",
  "missing-budget": "no budget",
  "missing-wasm": "not built",
};

function bytes(n: number | null): string {
  return n === null ? "-" : n.toLocaleString("en-US");
}

function signed(n: number | null): string {
  if (n === null) return "-";
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "-"}${Math.abs(n).toLocaleString("en-US")}`;
}

function percent(size: number | null, budget: number | null): string {
  if (size === null || budget === null) return "-";
  return `${((size / budget) * 100).toFixed(1)}%`;
}

/** A Markdown table, readable both in a terminal and in a job summary. */
export function renderWasmSizeReport(
  rows: WasmSizeRow[],
  baseLabel: string | null
): string {
  const lines = [
    `| Contract | Size (bytes) | Budget (bytes) | Used | Delta vs ${
      baseLabel ?? "base"
    } | Status |`,
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      (r) =>
        `| ${r.contract} | ${bytes(r.size)} | ${bytes(r.budget)} | ${percent(
          r.size,
          r.budget
        )} | ${signed(r.delta)} | ${STATUS_LABEL[r.status]} |`
    ),
  ];
  if (baseLabel === null) {
    lines.push("", "No base branch build to compare with; delta not shown.");
  }
  return lines.join("\n");
}
