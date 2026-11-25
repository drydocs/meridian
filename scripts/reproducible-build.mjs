#!/usr/bin/env node
// Reproducible contract builds (#1421).
//
// Builds every `meridian_*.wasm` contract twice in isolated CARGO_TARGET_DIRs
// with the pinned `stellar` CLI, compares the SHA-256 of each artifact, and
// writes a hash manifest that records the compiler and Soroban SDK versions.
//
// The build command is deliberately `stellar contract build`, not plain
// `cargo build`: the CLI remaps absolute paths, injects spec metadata, and
// optimizes the wasm, so its output differs from a bare cargo build. Using
// the same command the deploy scripts and verify job use is what makes the
// recorded hashes meaningful.
//
//   node scripts/reproducible-build.mjs
//     Build twice, fail on any hash mismatch, write
//     packages/contracts/build-manifest.json.
//
//   node scripts/reproducible-build.mjs --verify <file> [<file> ...]
//     Compare wasm files against the recorded manifest. Used by the deploy
//     scripts so they refuse artifacts that a verified build did not produce.
//
// The manifest is intentionally git-ignored: it describes one exact build of
// one exact commit, so it is published as a CI artifact rather than committed
// (a committed copy would go stale the moment contract source changed). The
// deploy runbook in apps/docs/operations/mainnet-deployment.md explains how to
// fetch the CI artifact or regenerate it locally.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");
const DEPLOYMENT_MANIFEST = join(
  REPO_ROOT,
  "packages",
  "shared",
  "deployed-contracts.json"
);
const BUILD_MANIFEST = join(CONTRACTS_DIR, "build-manifest.json");
const TARGET = "wasm32v1-none";
const WASM_PATTERN = /^meridian_.+\.wasm$/;

function fail(message) {
  console.error("reproducible-build: " + message);
  process.exit(1);
}

function capture(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: CONTRACTS_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

function gitHead() {
  return capture("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
}

function sorobanSdkVersion() {
  const lockPath = join(CONTRACTS_DIR, "Cargo.lock");
  if (!existsSync(lockPath)) return null;
  const lock = readFileSync(lockPath, "utf8");
  const match = lock.match(
    /\[\[package\]\]\s+name = "soroban-sdk"\s+version = "([^"]+)"/
  );
  return match ? match[1] : null;
}

function pinnedStellarCli() {
  if (!existsSync(DEPLOYMENT_MANIFEST)) return null;
  try {
    const manifest = JSON.parse(readFileSync(DEPLOYMENT_MANIFEST, "utf8"));
    return manifest?.toolchain?.stellarCli ?? null;
  } catch {
    return null;
  }
}

function installedStellarCli() {
  const output = capture("stellar", ["--version"]);
  if (!output) return null;
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : output;
}

function toolchainVersions() {
  const rustc = capture("rustc", ["-V"]);
  const cargo = capture("cargo", ["-V"]);
  if (!rustc || !cargo) {
    fail(
      "Rust toolchain not found. Install Rust with the " +
        TARGET +
        " target before running a reproducible build."
    );
  }

  const pinned = pinnedStellarCli();
  const installed = installedStellarCli();
  if (!installed) {
    fail(
      "the Stellar CLI was not found. Install the pinned version from " +
        "packages/shared/deployed-contracts.json (toolchain.stellarCli) before " +
        "running a reproducible build."
    );
  }
  if (pinned && installed !== pinned) {
    fail(
      "deployed-contracts.json pins stellar-cli " +
        pinned +
        ", but this machine has " +
        installed +
        ". Reproducible builds require the pinned version."
    );
  }

  return {
    stellarCli: pinned ?? installed,
    stellarCliInstalled: installed,
    rustc,
    cargo,
    sorobanSdk: sorobanSdkVersion(),
    target: TARGET,
  };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function collectWasm(targetDir) {
  const releaseDir = join(targetDir, TARGET, "release");
  if (!existsSync(releaseDir)) {
    fail("expected build output at " + releaseDir + " but it was not created.");
  }
  const wasm = readdirSync(releaseDir)
    .filter((name) => WASM_PATTERN.test(name))
    .sort();
  if (wasm.length === 0) {
    fail("no meridian_*.wasm artifacts found in " + releaseDir);
  }
  return wasm;
}

function buildInto(targetDir) {
  rmSync(targetDir, { recursive: true, force: true });
  const result = spawnSync("stellar", ["contract", "build", "--locked"], {
    cwd: CONTRACTS_DIR,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(
      "stellar contract build failed with exit code " + String(result.status)
    );
  }
  return collectWasm(targetDir);
}

function buildTwice() {
  const runId = String(process.pid);
  const firstDir = join(tmpdir(), "meridian-repro-" + runId + "-a");
  const secondDir = join(tmpdir(), "meridian-repro-" + runId + "-b");
  try {
    console.log("Building contracts twice in isolated target directories...");
    const first = buildInto(firstDir);
    const second = buildInto(secondDir);
    if (first.join(",") !== second.join(",")) {
      fail(
        "the two builds produced different artifact sets:\n  " +
          first.join(", ") +
          "\n  " +
          second.join(", ")
      );
    }

    const contracts = {};
    const mismatches = [];
    for (const file of first) {
      const a = sha256(join(firstDir, TARGET, "release", file));
      const b = sha256(join(secondDir, TARGET, "release", file));
      if (a !== b) {
        mismatches.push(file + ": " + a + " != " + b);
      }
      contracts[file.replace(/\.wasm$/, "")] = { file, sha256: a };
    }
    if (mismatches.length > 0) {
      fail(
        "two clean builds produced different hashes (the build is not " +
          "reproducible):\n  " +
          mismatches.join("\n  ")
      );
    }

    const manifest = {
      version: 1,
      note:
        "Generated by scripts/reproducible-build.mjs. Not committed: publish " +
        "it as the contract-build-manifest CI artifact and verify deploy " +
        "artifacts against it.",
      sourceCommit: gitHead(),
      toolchain: toolchainVersions(),
      contracts,
    };
    writeFileSync(BUILD_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
      "Reproducible build verified for " +
        first.length +
        " contract(s); wrote " +
        BUILD_MANIFEST
    );
    for (const file of first) {
      const hash = contracts[file.replace(/\.wasm$/, "")].sha256;
      console.log("  " + file + " " + hash);
    }
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
}

function verify(files) {
  if (!existsSync(BUILD_MANIFEST)) {
    fail(
      "no verified build manifest at " +
        BUILD_MANIFEST +
        ".\nRun `pnpm check:reproducible-build`, or download the " +
        "`contract-build-manifest` artifact from a successful CI run, before " +
        "deploying."
    );
  }
  const manifest = JSON.parse(readFileSync(BUILD_MANIFEST, "utf8"));
  const contracts = manifest.contracts ?? {};

  const targets =
    files.length > 0
      ? files.map((file) => resolve(file))
      : collectWasm(join(CONTRACTS_DIR, "target")).map((file) =>
          join(CONTRACTS_DIR, "target", TARGET, "release", file)
        );

  let failed = false;
  for (const file of targets) {
    if (!existsSync(file)) {
      console.error("reproducible-build: missing artifact " + file);
      failed = true;
      continue;
    }
    const name = basename(file, extname(file));
    const expected = contracts[name];
    if (!expected) {
      console.error(
        "reproducible-build: " +
          basename(file) +
          " is not recorded in the verified build manifest."
      );
      failed = true;
      continue;
    }
    const actual = sha256(file);
    if (actual !== expected.sha256) {
      console.error(
        "reproducible-build: " +
          basename(file) +
          " does not match the verified manifest: expected " +
          expected.sha256 +
          ", found " +
          actual
      );
      failed = true;
      continue;
    }
    console.log("Verified " + basename(file) + " " + actual);
  }
  if (failed) {
    process.exit(1);
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "--verify") {
  verify(rest);
} else if (mode === undefined) {
  buildTwice();
} else {
  fail("unknown argument: " + mode + " (use --verify <file>...)");
}
