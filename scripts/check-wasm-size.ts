#!/usr/bin/env tsx
/**
 * Contract WASM size budget check (#1353).
 *
 *   pnpm check:wasm-size [--build] [--base-ref <git ref>]
 *
 * Measures every `*.wasm` in packages/contracts/target/wasm32v1-none/release
 * (the directory the deploy scripts upload from), compares each with its
 * budget in packages/contracts/wasm-size-budgets.json, and prints a report
 * with the delta from the base branch. Exits 1 when a contract is over
 * budget, has no budget, or has a budget but was not built.
 *
 * --build       build first, using the deploy path (`stellar contract build`)
 *               when the Stellar CLI is installed, otherwise the equivalent
 *               `cargo build --target wasm32v1-none --release` that CI runs.
 * --base-ref    also build that ref in a temporary git worktree with the same
 *               command and report each contract's delta from it. Defaults to
 *               $WASM_SIZE_BASE_REF. A base that fails to build only drops the
 *               delta column; it never fails the check.
 *
 * When $GITHUB_STEP_SUMMARY is set the report is also written to the job
 * summary.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareWasmSizes,
  renderWasmSizeReport,
  wasmSizeBudgetManifestSchema,
  wasmSizeFailures,
} from "../packages/shared/src/wasm-size-budget";

const REPO_ROOT = join(__dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");
const WASM_SUBDIR = join("wasm32v1-none", "release");
const BUDGETS_PATH = join(CONTRACTS_DIR, "wasm-size-budgets.json");

function hasStellarCli(): boolean {
  return spawnSync("stellar", ["--version"], { stdio: "ignore" }).status === 0;
}

/** Builds the contracts in `contractsDir`; returns false on failure. */
function build(contractsDir: string, targetDir?: string): boolean {
  const env = targetDir
    ? { ...process.env, CARGO_TARGET_DIR: targetDir }
    : process.env;
  const [cmd, args] = hasStellarCli()
    ? ["stellar", ["contract", "build"]]
    : ["cargo", ["build", "--target", "wasm32v1-none", "--release"]];
  console.error(`$ ${cmd} ${args.join(" ")}  (in ${contractsDir})`);
  return (
    spawnSync(cmd, args, { cwd: contractsDir, env, stdio: "inherit" })
      .status === 0
  );
}

function measure(wasmDir: string): Record<string, number> {
  if (!existsSync(wasmDir)) return {};
  const sizes: Record<string, number> = {};
  for (const file of readdirSync(wasmDir).sort()) {
    if (file.endsWith(".wasm")) {
      sizes[file.slice(0, -".wasm".length)] = statSync(
        join(wasmDir, file)
      ).size;
    }
  }
  return sizes;
}

/** Builds `ref` in a throwaway worktree and measures it; null on failure. */
function measureBase(ref: string): Record<string, number> | null {
  const worktree = mkdtempSync(join(tmpdir(), "wasm-size-base-"));
  const targetDir = join(CONTRACTS_DIR, "target", "wasm-size-base");
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, ref], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    if (!build(join(worktree, "packages", "contracts"), targetDir)) {
      console.error(`Base ${ref} failed to build; delta not reported.`);
      return null;
    }
    return measure(join(targetDir, WASM_SUBDIR));
  } catch (err) {
    console.error(`Could not check out base ${ref}: ${String(err)}`);
    return null;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    rmSync(worktree, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const args = argv.filter((a) => a !== "--");
  const refIndex = args.indexOf("--base-ref");
  const baseRef =
    (refIndex >= 0 ? args[refIndex + 1] : process.env.WASM_SIZE_BASE_REF) ||
    null;

  const manifest = wasmSizeBudgetManifestSchema.parse(
    JSON.parse(readFileSync(BUDGETS_PATH, "utf8"))
  );
  if (args.includes("--build") && !build(CONTRACTS_DIR)) {
    console.error("Contract build failed.");
    return 1;
  }
  const sizes = measure(join(CONTRACTS_DIR, "target", WASM_SUBDIR));
  if (Object.keys(sizes).length === 0) {
    console.error(
      "No WASM found in packages/contracts/target/wasm32v1-none/release. Build first or pass --build."
    );
    return 1;
  }
  const baseSizes = baseRef ? measureBase(baseRef) : null;
  const rows = compareWasmSizes(manifest.budgets, sizes, baseSizes);
  const label = baseSizes && baseRef ? baseRef.slice(0, 12) : null;
  const report = renderWasmSizeReport(rows, label);
  const failures = wasmSizeFailures(rows);
  const verdict =
    failures.length === 0
      ? "All contracts are within their WASM size budgets."
      : `${failures.length} contract(s) failed the WASM size budget check: ${failures
          .map((f) => `${f.contract} (${f.status})`)
          .join(
            ", "
          )}. If the growth is intentional, raise the budget in packages/contracts/wasm-size-budgets.json (see CONTRIBUTING.md).`;

  console.log(`${report}\n\n${verdict}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Contract WASM sizes\n\n${report}\n\n${verdict}\n`
    );
  }
  for (const f of failures) {
    console.log(
      `::error title=WASM size budget::${f.contract}: ${f.status} (size ${f.size ?? "-"}, budget ${f.budget ?? "-"})`
    );
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
