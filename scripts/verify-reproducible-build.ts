#!/usr/bin/env tsx
/**
 * Reproducible contract build verification (#1421).
 *
 *   pnpm verify:reproducible-build -- --build [--manifest <path>]
 *   pnpm verify:reproducible-build -- --no-build --manifest <path>
 *
 * `--build` builds every contract twice in separate, empty target directories,
 * compares the SHA-256 of each released WASM, and fails if any hash differs.
 * The first build is staged into packages/contracts/target/wasm32v1-none/release
 * (the directory the deploy scripts upload from) only after both builds agree,
 * and a hash manifest recording the compiler and Soroban SDK versions is
 * written to `--manifest` (default target/reproducible-build.json).
 *
 * `--no-build` does not compile anything: it hashes the already-present WASM
 * and refuses to continue unless every artifact matches the supplied manifest.
 * The deploy scripts use that mode for SKIP_BUILD, where the caller supplies a
 * WASM verified elsewhere (e.g. a Linux CI build) together with its manifest.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  hashMismatches,
  reproducibleBuildManifestSchema,
  reproducibleBuildMismatches,
  type HashMismatch,
  type ReproducibleBuildManifest,
} from "../packages/shared/src/reproducible-build";

const REPO_ROOT = join(__dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");
const DEPLOY_WASM_DIR = join(
  CONTRACTS_DIR,
  "target",
  "wasm32v1-none",
  "release"
);
const DEFAULT_MANIFEST = join(
  CONTRACTS_DIR,
  "target",
  "reproducible-build.json"
);
interface BuildResult {
  targetDir: string;
  wasmDir: string;
  hashes: Record<string, string>;
}

function commandAvailable(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

function compilerVersion(): string {
  return output("rustc", ["--version"]);
}

function sorobanSdkVersion(): string {
  const lockfile = readFileSync(
    join(CONTRACTS_DIR, "Cargo.lock"),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const match =
    /^\[\[package\]\]\nname = "soroban-sdk"\nversion = "([^"]+)"/m.exec(
      lockfile
    );
  if (!match) {
    throw new Error("Could not find the locked soroban-sdk version.");
  }
  return match[1]!;
}

function stellarCliVersion(): string | null {
  if (!commandAvailable("stellar")) {
    return null;
  }
  const version = output("stellar", ["--version"]);
  return /^[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)/.exec(version)?.[1] ?? version;
}

function hashWasmDir(wasmDir: string): Record<string, string> {
  if (!existsSync(wasmDir)) {
    throw new Error("Build produced no WASM directory: " + wasmDir);
  }
  const hashes: Record<string, string> = {};
  const files = readdirSync(wasmDir)
    .filter((file) => file.endsWith(".wasm"))
    .sort();
  if (files.length === 0) {
    throw new Error("Build produced no WASM files in " + wasmDir);
  }
  for (const file of files) {
    hashes[file.slice(0, -".wasm".length)] = createHash("sha256")
      .update(readFileSync(join(wasmDir, file)))
      .digest("hex");
  }
  return hashes;
}

function buildOnce(label: string, builder: "stellar" | "cargo"): BuildResult {
  const targetDir = mkdtempSync(
    join(tmpdir(), "meridian-repro-" + label + "-")
  );
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
  const outDir = join(targetDir, "out");
  const [command, args] =
    builder === "stellar"
      ? ["stellar", ["contract", "build", "--out-dir", outDir]]
      : [
          "cargo",
          ["build", "--locked", "--target", "wasm32v1-none", "--release"],
        ];
  console.log(
    "$ " + command + " " + args.join(" ") + "  (" + label + " build)"
  );
  const result = spawnSync(command, args, {
    cwd: CONTRACTS_DIR,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error("Contract build failed (" + label + " build).");
  }
  const wasmDir =
    builder === "stellar"
      ? outDir
      : join(targetDir, "wasm32v1-none", "release");
  return { targetDir, wasmDir, hashes: hashWasmDir(wasmDir) };
}

function stageArtifacts(wasmDir: string): void {
  mkdirSync(DEPLOY_WASM_DIR, { recursive: true });
  for (const file of readdirSync(DEPLOY_WASM_DIR)) {
    if (file.endsWith(".wasm")) {
      rmSync(join(DEPLOY_WASM_DIR, file));
    }
  }
  for (const file of readdirSync(wasmDir)) {
    if (file.endsWith(".wasm")) {
      copyFileSync(join(wasmDir, file), join(DEPLOY_WASM_DIR, file));
    }
  }
}

function writeManifest(
  path: string,
  manifest: ReproducibleBuildManifest
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = path + "." + process.pid + ".tmp";
  writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o644,
  });
  renameSync(temporaryPath, path);
  console.log("Wrote reproducible build manifest: " + path);
}

function loadManifest(path: string): ReproducibleBuildManifest {
  if (!existsSync(path)) {
    throw new Error(
      "Reproducible build manifest not found at " +
        path +
        ". Build with --build first, or pass the manifest that was published " +
        "with the externally verified WASM."
    );
  }
  return reproducibleBuildManifestSchema.parse(
    JSON.parse(readFileSync(path, "utf8"))
  );
}

function describe(mismatch: HashMismatch): string {
  return (
    "  " +
    mismatch.contract +
    ": expected " +
    String(mismatch.expected) +
    ", found " +
    String(mismatch.actual)
  );
}

function failOnMismatches(mismatches: HashMismatch[], message: string): void {
  if (mismatches.length === 0) {
    return;
  }
  console.error(message);
  for (const mismatch of mismatches) {
    console.error(describe(mismatch));
  }
  throw new Error(message);
}

function report(manifest: ReproducibleBuildManifest, label: string): void {
  const rows = Object.keys(manifest.contracts)
    .sort()
    .map(
      (contract) =>
        "| " + contract + " | " + manifest.contracts[contract] + " |"
    );
  const table = ["| Contract | SHA-256 |", "| --- | --- |", ...rows].join("\n");
  const versions =
    "Builder: " +
    manifest.toolchain.builder +
    " | rustc: " +
    manifest.toolchain.rustc +
    " | soroban-sdk: " +
    manifest.toolchain.sorobanSdk +
    " | stellar-cli: " +
    (manifest.toolchain.stellarCli ?? "not installed");
  console.log("\n" + label + "\n" + versions + "\n\n" + table + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "## Reproducible contract build\n\n" + versions + "\n\n" + table + "\n"
    );
  }
}

function build(): ReproducibleBuildManifest {
  const requestedBuilder = process.env.REPRODUCIBLE_BUILD_BUILDER?.trim();
  if (
    requestedBuilder !== undefined &&
    requestedBuilder !== "" &&
    requestedBuilder !== "stellar" &&
    requestedBuilder !== "cargo"
  ) {
    throw new Error(
      "REPRODUCIBLE_BUILD_BUILDER must be 'stellar' or 'cargo', found '" +
        requestedBuilder +
        "'."
    );
  }
  const builder: "stellar" | "cargo" =
    requestedBuilder === "stellar" || requestedBuilder === "cargo"
      ? requestedBuilder
      : commandAvailable("stellar")
        ? "stellar"
        : "cargo";
  if (builder === "stellar" && !commandAvailable("stellar")) {
    throw new Error(
      "REPRODUCIBLE_BUILD_BUILDER=stellar requires the Stellar CLI on PATH."
    );
  }

  console.log(
    "Building every contract twice in clean target directories with " +
      builder +
      "..."
  );
  const first = buildOnce("first", builder);
  let second: BuildResult;
  try {
    second = buildOnce("second", builder);
  } catch (error) {
    rmSync(first.targetDir, { recursive: true, force: true });
    throw error;
  }

  try {
    failOnMismatches(
      hashMismatches(first.hashes, second.hashes),
      "Two clean builds produced different WASM hashes:"
    );

    const manifest = reproducibleBuildManifestSchema.parse({
      version: 1,
      toolchain: {
        builder,
        rustc: compilerVersion(),
        sorobanSdk: sorobanSdkVersion(),
        stellarCli: builder === "stellar" ? stellarCliVersion() : null,
        target: "wasm32v1-none",
      },
      contracts: first.hashes,
    } satisfies ReproducibleBuildManifest);

    stageArtifacts(first.wasmDir);
    return manifest;
  } finally {
    rmSync(first.targetDir, { recursive: true, force: true });
    rmSync(second.targetDir, { recursive: true, force: true });
  }
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv
      .slice(2)
      .filter((arg, index) => index !== 0 || arg !== "--"),
    options: {
      build: { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      manifest: { type: "string" },
      artifacts: { type: "string" },
    },
    strict: true,
  });

  const manifestPath = values.manifest ?? DEFAULT_MANIFEST;
  const artifactsDir = values.artifacts ?? DEPLOY_WASM_DIR;
  const noBuild = values["no-build"] || !values.build;

  if (noBuild) {
    const manifest = loadManifest(manifestPath);
    const actual = hashWasmDir(artifactsDir);
    failOnMismatches(
      reproducibleBuildMismatches(manifest, actual),
      "WASM does not match the reproducible build manifest"
    );
    report(manifest, "Artifacts verified against " + manifestPath);
    return;
  }

  const manifest = build();
  writeManifest(manifestPath, manifest);

  const staged = hashWasmDir(DEPLOY_WASM_DIR);
  failOnMismatches(
    reproducibleBuildMismatches(manifest, staged),
    "Staged WASM does not match the verified build"
  );
  report(manifest, "Two clean builds matched byte-for-byte");
}

try {
  main();
} catch (error) {
  console.error(
    "Reproducible build check failed: " +
      (error instanceof Error ? error.message : String(error))
  );
  process.exitCode = 1;
}
