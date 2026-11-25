#!/usr/bin/env tsx
/**
 * Soroban resource benchmark gate (#1272).
 *
 *   pnpm check:contract-benchmarks --input <log> --baseline <json> \
 *     --output <json> [--update]
 *
 * Reads the `SOROBAN_BENCHMARK|name|cpu|memory|fee` records that the contract
 * tests print, compares them with the checked-in baselines and fails when a
 * metric exceeds its baseline by more than the configured tolerance, when the
 * benchmark set differs, or when the Rust compiler or Soroban SDK version
 * differs from the one the baselines were measured with. With `--update` the
 * baseline file is rewritten from the current measurements.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS = ["cpu_instructions", "memory_bytes", "fee_stroops"] as const;
type Metric = (typeof METRICS)[number];
type Resources = Record<Metric, number>;

interface Baseline {
  baseline_policy: string;
  rustc_version: string;
  soroban_sdk_version: string;
  tolerance_percent: number;
  benchmarks: Record<string, Resources>;
}

const RECORD = /SOROBAN_BENCHMARK\|([^|]+)\|(\d+)\|(\d+)\|(\d+)/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let update = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--update") {
      update = true;
    } else if (["--input", "--baseline", "--output"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      values[arg.slice(2)] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const required of ["input", "baseline", "output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return {
    input: resolve(values["input"]!),
    baseline: resolve(values["baseline"]!),
    output: resolve(values["output"]!),
    update,
  };
}

function compilerVersion(): string {
  return execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
}

function lockedSdkVersion(): string {
  const lockfile = resolve(ROOT, "packages/contracts/Cargo.lock");
  const text = readFileSync(lockfile, "utf8").replace(/\r\n/g, "\n");
  const match =
    /^\[\[package\]\]\nname = "soroban-sdk"\nversion = "([^"]+)"/m.exec(text);
  if (!match) {
    throw new Error(`could not find soroban-sdk version in ${lockfile}`);
  }
  return match[1]!;
}

function readResults(path: string): Record<string, Resources> {
  const results: Record<string, Resources> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = RECORD.exec(line);
    if (!match) continue;
    const [, name, cpu, memory, fee] = match;
    if (name! in results) {
      throw new Error(`duplicate benchmark result: ${name}`);
    }
    results[name!] = {
      cpu_instructions: Number(cpu),
      memory_bytes: Number(memory),
      fee_stroops: Number(fee),
    };
  }
  if (Object.keys(results).length === 0) {
    throw new Error(`no benchmark records found in ${path}`);
  }
  return results;
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)])
    ) as T;
  }
  return value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortKeys(value), null, 2)}\n`, "utf8");
}

function main(): number {
  const args = readArgs(process.argv.slice(2));
  const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as Baseline;
  const measured = readResults(args.input);
  const sdkVersion = lockedSdkVersion();

  if (!args.update && sdkVersion !== baseline.soroban_sdk_version) {
    throw new Error(
      `Soroban SDK lockfile version ${sdkVersion} differs from baseline ` +
        `${baseline.soroban_sdk_version}; review and refresh the baseline`
    );
  }

  const expected = new Set(Object.keys(baseline.benchmarks));
  const actual = new Set(Object.keys(measured));
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `benchmark set mismatch; missing=${JSON.stringify(missing)}, ` +
        `unexpected=${JSON.stringify(unexpected)}`
    );
  }

  const rustc = compilerVersion();
  const tolerance = baseline.tolerance_percent;
  writeJson(args.output, {
    rustc_version: rustc,
    soroban_sdk_version: sdkVersion,
    tolerance_percent: tolerance,
    benchmarks: measured,
  });

  if (!args.update && rustc !== baseline.rustc_version) {
    throw new Error(
      `Rust compiler version '${rustc}' differs from baseline ` +
        `'${baseline.rustc_version}'; review and refresh the baseline`
    );
  }

  if (args.update) {
    writeJson(args.baseline, {
      ...baseline,
      rustc_version: rustc,
      soroban_sdk_version: sdkVersion,
      baseline_policy:
        "Measured native Soroban cost estimates; tolerance is applied separately.",
      benchmarks: measured,
    });
    console.log(
      `Updated ${args.baseline} with ${Object.keys(measured).length} benchmark results.`
    );
    return 0;
  }

  const failures: string[] = [];
  for (const name of [...expected].sort()) {
    for (const metric of METRICS) {
      const limit = baseline.benchmarks[name]![metric];
      const value = measured[name]![metric];
      // Ceiling of limit * (100 + tolerance) / 100.
      const allowed = Math.ceil((limit * (100 + tolerance)) / 100);
      if (value > allowed) {
        failures.push(
          `${name} ${metric}: ${value} exceeds ${allowed} ` +
            `(baseline ${limit}, tolerance ${tolerance}%)`
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("Soroban benchmark regression(s):");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(`Current results were written to ${args.output}.`);
    return 1;
  }

  console.log(
    `All ${Object.keys(measured).length} Soroban benchmarks are within ${tolerance}% of baseline.`
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(
    `Benchmark check failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 2;
}
