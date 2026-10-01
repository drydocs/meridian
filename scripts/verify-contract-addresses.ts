#!/usr/bin/env tsx
/**
 * Verifies the vault contract addresses this repo records against the deploy
 * record in packages/shared/deployed-contracts.json, and, when a redeployment
 * is being recorded, against the bytecode actually live on-chain.
 *
 * This guards a specific supply-chain risk: a PR can submit clean, reviewable
 * source while pointing a contract address at different, unreviewed bytecode
 * the contributor deployed themselves. Reviewing the source diff alone cannot
 * catch that.
 *
 * Meridian's vault is immutable (no update_current_contract_wasm), so the
 * bytecode at a recorded address never changes once deployed. That lets the
 * check separate two cases instead of rebuilding on every PR:
 *
 *   1. The deploy record was NOT edited in this PR.
 *      - Addresses in the record and CONTRACT_ADDRESSES agree: pass without a
 *        build. The addresses are unchanged, so their bytecode is unchanged.
 *      - Addresses disagree: fail. An address moved without updating the
 *        deploy record, which a genuine redeployment always does.
 *   2. The deploy record WAS edited in this PR.
 *      - Record and CONTRACT_ADDRESSES disagree: fail. The two files must
 *        state the same addresses.
 *      - They agree: build the vault from this PR's source and compare the
 *        hash against the on-chain bytecode at every address that changed in
 *        this PR. A match passes; a mismatch fails.
 *
 * A manual run (workflow_dispatch, no base commit to diff against) audits
 * every recorded address by building and comparing against the chain.
 *
 * Only the vault contract is checked, since it's the only contract whose
 * address is tracked here and whose source lives in this repo. Third-party
 * contracts (Blend's pool, DeFindex's factory/vault, the USDC/EURC issuers)
 * can't be verified this way, since nobody here controls their source.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_ADDRESSES,
  STELLAR_NETWORKS,
} from "../packages/shared/src/constants";
import { KNOWN_POOLS } from "../packages/stellar-sdk-helpers/src/known-pools";

const REPO_ROOT = join(__dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");
const BUILT_WASM_PATH = join(
  CONTRACTS_DIR,
  "target",
  "wasm32v1-none",
  "release",
  "meridian_vault.wasm"
);
const DEPLOY_RECORD_PATH = join(
  REPO_ROOT,
  "packages",
  "shared",
  "deployed-contracts.json"
);
const DEPLOY_RECORD_REPO_PATH = "packages/shared/deployed-contracts.json";
const CONSTANTS_REPO_PATH = "packages/shared/src/constants.ts";

const NETWORKS = ["testnet", "mainnet"] as const;
type Network = (typeof NETWORKS)[number];

interface DeployRecord {
  toolchain: { stellarCli: string; target: string };
  contracts: Record<Network, { vault: { address: string; wasmHash: string } }>;
}

type Action = "pass" | "fail" | "build";

interface Decision {
  action: Action;
  message: string;
  buildNetworks: Network[];
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(
  fn: () => T,
  { attempts = 3, delayMs = 3000 } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(
          `  attempt ${i + 1}/${attempts} failed, retrying in ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

async function fetchOnChainHash(
  address: string,
  network: Network
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "meridian-verify-"));
  const outFile = join(dir, `${address}.wasm`);
  // stellar-cli's built-in "mainnet" network preset has no default RPC
  // endpoint (there is no SDF-run public mainnet RPC the way there is for
  // testnet): `--network mainnet` alone resolves to a placeholder
  // "bring your own" URL and fails outright, not just less reliably. Passing
  // the same rpcUrl/passphrase this repo's own deploy tooling uses avoids
  // that entirely, for both networks.
  const { rpcUrl, passphrase } = STELLAR_NETWORKS[network];
  await retry(() => {
    execFileSync(
      "stellar",
      [
        "contract",
        "fetch",
        "--id",
        address,
        "--rpc-url",
        rpcUrl,
        "--network-passphrase",
        passphrase,
        "-o",
        outFile,
      ],
      { stdio: "inherit" }
    );
  });
  return sha256(outFile);
}

function loadDeployRecord(): DeployRecord {
  if (!existsSync(DEPLOY_RECORD_PATH)) {
    throw new Error(`Deploy record not found at ${DEPLOY_RECORD_PATH}`);
  }
  return JSON.parse(readFileSync(DEPLOY_RECORD_PATH, "utf8")) as DeployRecord;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

function gitOrNull(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function wasDeployRecordEdited(baseSha: string): boolean {
  const changed = git(["diff", "--name-only", baseSha, "HEAD"]).split("\n");
  return changed.includes(DEPLOY_RECORD_REPO_PATH);
}

// Extracts the per-network CONTRACT_ADDRESSES.<network>.vault values from a
// given revision of constants.ts. The top-level per-network vault entries sit
// at exactly four-space indentation, distinguishing them from the six-space
// nested defindex.vault entries. Returns null if the revision or the file is
// unavailable (e.g. the file is newly introduced in this PR), so the caller
// can fall back to treating every address as changed.
function readVaultAddressesAt(sha: string): Record<Network, string> | null {
  const source = gitOrNull(["show", `${sha}:${CONSTANTS_REPO_PATH}`]);
  if (source === null) return null;

  const result: Partial<Record<Network, string>> = {};
  for (const network of NETWORKS) {
    const blockStart = source.indexOf(`  ${network}: {`);
    if (blockStart === -1) return null;
    const rest = source.slice(blockStart);
    const match = rest.match(/^ {4}vault: "([A-Z0-9]{56})"/m);
    if (!match) return null;
    result[network] = match[1];
  }
  return result as Record<Network, string>;
}

function checkInternalConsistency(): string | null {
  const constantsVault = CONTRACT_ADDRESSES.testnet.vault;
  const knownPoolVault = KNOWN_POOLS.testnet["meridian-usdc"]?.contractId;
  if (knownPoolVault && constantsVault && knownPoolVault !== constantsVault) {
    return (
      "CONTRACT_ADDRESSES.testnet.vault and " +
      'KNOWN_POOLS.testnet["meridian-usdc"].contractId disagree on the vault ' +
      `address: ${constantsVault} vs ${knownPoolVault}`
    );
  }
  return null;
}

function recordVsConstantsMismatches(record: DeployRecord): string[] {
  const mismatches: string[] = [];
  for (const network of NETWORKS) {
    const recorded = record.contracts[network]?.vault.address;
    const inConstants = CONTRACT_ADDRESSES[network].vault;
    if (recorded !== inConstants) {
      mismatches.push(
        `${network}: deploy record has ${recorded}, ` +
          `CONTRACT_ADDRESSES has ${inConstants}`
      );
    }
  }
  return mismatches;
}

function decide(record: DeployRecord): Decision {
  const consistencyError = checkInternalConsistency();
  if (consistencyError) {
    return { action: "fail", message: consistencyError, buildNetworks: [] };
  }

  const baseSha = process.env.VERIFY_BASE_SHA?.trim();

  // No base commit to diff against (manual workflow_dispatch): audit every
  // recorded address by building and comparing against the chain.
  if (!baseSha) {
    const mismatches = recordVsConstantsMismatches(record);
    if (mismatches.length > 0) {
      return {
        action: "fail",
        message:
          "Deploy record and CONTRACT_ADDRESSES disagree:\n  " +
          mismatches.join("\n  "),
        buildNetworks: [],
      };
    }
    return {
      action: "build",
      message: "Manual audit: verifying every recorded address on-chain.",
      buildNetworks: [...NETWORKS],
    };
  }

  const recordEdited = wasDeployRecordEdited(baseSha);
  const mismatches = recordVsConstantsMismatches(record);

  if (!recordEdited) {
    if (mismatches.length > 0) {
      return {
        action: "fail",
        message:
          "A vault address changed without updating the deploy record " +
          `(${DEPLOY_RECORD_REPO_PATH}). A redeployment must record its new ` +
          "address and bytecode there.\n  " +
          mismatches.join("\n  "),
        buildNetworks: [],
      };
    }
    return {
      action: "pass",
      message:
        "Deploy record unchanged and addresses match. Vault bytecode is " +
        "immutable at a fixed address, so no rebuild is needed.",
      buildNetworks: [],
    };
  }

  if (mismatches.length > 0) {
    return {
      action: "fail",
      message:
        `The deploy record (${DEPLOY_RECORD_REPO_PATH}) and ` +
        "CONTRACT_ADDRESSES disagree:\n  " +
        mismatches.join("\n  "),
      buildNetworks: [],
    };
  }

  // Deploy record edited and addresses agree. Build and verify only the
  // addresses that actually changed in this PR. An unchanged network's vault
  // holds older bytecode that this PR's source is not expected to reproduce.
  const baseVaults = readVaultAddressesAt(baseSha);
  const buildNetworks = NETWORKS.filter((network) => {
    if (!baseVaults) return true;
    return baseVaults[network] !== CONTRACT_ADDRESSES[network].vault;
  });

  if (buildNetworks.length === 0) {
    return {
      action: "pass",
      message:
        "Deploy record edited but no vault address changed (e.g. a toolchain " +
        "or metadata update). No rebuild is needed.",
      buildNetworks: [],
    };
  }

  return {
    action: "build",
    message:
      "Deploy record edited with new vault address(es): " +
      `${buildNetworks.join(", ")}. Building from source and verifying ` +
      "against on-chain bytecode.",
    buildNetworks,
  };
}

function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

async function verifyOnChain(
  record: DeployRecord,
  buildNetworks: Network[]
): Promise<void> {
  console.log("Building vault contract from source...");
  execFileSync("stellar", ["contract", "build"], {
    cwd: CONTRACTS_DIR,
    stdio: "inherit",
  });

  if (!existsSync(BUILT_WASM_PATH)) {
    console.error(`Expected built WASM not found at ${BUILT_WASM_PATH}`);
    process.exit(1);
  }
  const builtHash = sha256(BUILT_WASM_PATH);
  console.log(`Locally built vault WASM hash: ${builtHash}`);

  let failed = false;
  for (const network of buildNetworks) {
    const address = record.contracts[network].vault.address;
    console.log(`Verifying ${network} vault (${address})...`);
    const onChainHash = await fetchOnChainHash(address, network);
    console.log(`  on-chain hash: ${onChainHash}`);

    if (onChainHash !== builtHash) {
      console.error(
        `MISMATCH: ${network} vault (${address}) on-chain bytecode does not ` +
          "match the vault contract built from this PR's source."
      );
      failed = true;
    } else {
      console.log("  OK: matches source built from this PR.");
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log(
    "All changed vault addresses verified against on-chain bytecode."
  );
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--verify") ? "verify" : "plan";
  const record = loadDeployRecord();
  const decision = decide(record);

  console.log(decision.message);

  if (decision.action === "fail") {
    process.exit(1);
  }

  if (mode === "plan") {
    setOutput("needs_build", decision.action === "build" ? "true" : "false");
    return;
  }

  // verify mode: the workflow only reaches here when plan asked for a build.
  if (decision.action !== "build") {
    console.log("Nothing to build; verification already satisfied by plan.");
    return;
  }
  await verifyOnChain(record, decision.buildNetworks);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
