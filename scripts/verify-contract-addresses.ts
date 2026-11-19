#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Contract, rpc, scValToNative } from "@stellar/stellar-sdk";
import {
  DEPLOYMENT_NETWORKS,
  deploymentManifestSchema,
  deploymentStateMismatches,
  type DeploymentManifest,
  type DeploymentNetwork,
  type LiveContractSnapshot,
  type LiveDeploymentSnapshot,
  type NetworkDeployment,
} from "../packages/shared/src/deployment-manifest";
import {
  CONTRACT_ADDRESSES,
  STELLAR_NETWORKS,
} from "../packages/shared/src/constants";
import { KNOWN_POOLS } from "../packages/stellar-sdk-helpers/src/known-pools";

const REPO_ROOT = join(__dirname, "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "contracts");
const BUILD_DIR = join(CONTRACTS_DIR, "target", "wasm32v1-none", "release");
const MANIFEST_PATH = join(
  REPO_ROOT,
  "packages",
  "shared",
  "deployed-contracts.json"
);
const MANIFEST_REPO_PATH = "packages/shared/deployed-contracts.json";

type Action = "pass" | "fail" | "build";

interface Decision {
  action: Action;
  message: string;
  buildNetworks: DeploymentNetwork[];
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(
  operation: () => Promise<T>,
  attempts = 3,
  delayMs = 3000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(
          "  attempt " +
            attempt +
            "/" +
            attempts +
            " failed, retrying in " +
            delayMs +
            "ms..."
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function loadManifest(): DeploymentManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error("Deployment manifest not found at " + MANIFEST_PATH);
  }
  return deploymentManifestSchema.parse(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
  );
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

function wasManifestEdited(baseSha: string): boolean {
  return git(["diff", "--name-only", baseSha, "HEAD"])
    .split("\n")
    .includes(MANIFEST_REPO_PATH);
}

function readVaultAddressesAt(
  sha: string
): Record<DeploymentNetwork, string> | null {
  const source = gitOrNull(["show", sha + ":" + MANIFEST_REPO_PATH]);
  if (source === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(source) as {
      contracts?: Record<string, { vault?: { address?: string } }>;
    };
    const testnet = parsed.contracts?.testnet?.vault?.address;
    const mainnet = parsed.contracts?.mainnet?.vault?.address;
    return testnet && mainnet ? { testnet, mainnet } : null;
  } catch {
    return null;
  }
}

function checkInternalConsistency(): string | null {
  for (const network of DEPLOYMENT_NETWORKS) {
    const constantsVault = CONTRACT_ADDRESSES[network].vault;
    const knownPoolVault = KNOWN_POOLS[network]["meridian-usdc"]?.contractId;
    if (knownPoolVault && knownPoolVault !== constantsVault) {
      return (
        "CONTRACT_ADDRESSES." +
        network +
        ".vault and KNOWN_POOLS." +
        network +
        "[meridian-usdc].contractId disagree: " +
        constantsVault +
        " vs " +
        knownPoolVault
      );
    }
  }
  return null;
}

function manifestVsConstantsMismatches(manifest: DeploymentManifest): string[] {
  const mismatches: string[] = [];
  for (const network of DEPLOYMENT_NETWORKS) {
    const deployment = manifest.contracts[network];
    const constants = CONTRACT_ADDRESSES[network];
    const comparisons = [
      ["vault", deployment.vault.address, constants.vault],
      ["USDC", deployment.expectedState.usdc, constants.usdc],
      ["mUSDC", deployment.expectedState.musdc, constants.musdc],
      [
        "Blend pool",
        deployment.blendAdapter.constructorArgs.pool,
        constants.blend.pool,
      ],
    ];
    for (const [label, recorded, configured] of comparisons) {
      if (recorded !== configured) {
        mismatches.push(
          network +
            " " +
            label +
            ": manifest has " +
            recorded +
            ", constants have " +
            configured
        );
      }
    }
  }
  return mismatches;
}

function decide(manifest: DeploymentManifest): Decision {
  const consistencyError = checkInternalConsistency();
  if (consistencyError) {
    return { action: "fail", message: consistencyError, buildNetworks: [] };
  }

  const mismatches = manifestVsConstantsMismatches(manifest);
  if (mismatches.length > 0) {
    return {
      action: "fail",
      message:
        "Deployment manifest and checked-in constants disagree:\n  " +
        mismatches.join("\n  "),
      buildNetworks: [],
    };
  }

  const baseSha = process.env.VERIFY_BASE_SHA?.trim();
  if (!baseSha) {
    return {
      action: "build",
      message: "Manual audit: verify every recorded deployment against source.",
      buildNetworks: [...DEPLOYMENT_NETWORKS],
    };
  }

  if (!wasManifestEdited(baseSha)) {
    return {
      action: "pass",
      message:
        "Deployment manifest unchanged and addresses match checked-in constants.",
      buildNetworks: [],
    };
  }

  const previousVaults = readVaultAddressesAt(baseSha);
  const buildNetworks = DEPLOYMENT_NETWORKS.filter(
    (network) =>
      previousVaults === null ||
      previousVaults[network] !== manifest.contracts[network].vault.address
  );
  if (buildNetworks.length === 0) {
    return {
      action: "pass",
      message:
        "Deployment metadata changed without a vault redeployment; no source rebuild is needed.",
      buildNetworks: [],
    };
  }

  return {
    action: "build",
    message:
      "New deployment recorded for " +
      buildNetworks.join(", ") +
      "; verify its bytecode against this source tree.",
    buildNetworks,
  };
}

function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, key + "=" + value + "\n");
  }
}

function nativeStorageValue(
  value: unknown
): string | number | boolean | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : value.toString();
  }
  return undefined;
}

async function fetchContractSnapshot(
  server: rpc.Server,
  address: string
): Promise<LiveContractSnapshot> {
  return retry(async () => {
    const response = await server.getLedgerEntries(
      new Contract(address).getFootprint()
    );
    const entry = response.entries[0];
    if (!entry) {
      throw new Error("Contract instance not found: " + address);
    }

    const instance = entry.val.contractData().val().instance();
    const storage: LiveContractSnapshot["storage"] = {};
    for (const item of instance.storage() ?? []) {
      const key = scValToNative(item.key());
      const value = nativeStorageValue(scValToNative(item.val()));
      if (typeof key === "string" && value !== undefined) {
        storage[key] = value;
      }
    }

    return {
      wasmHash: instance.executable().wasmHash().toString("hex"),
      storage,
    };
  });
}

async function fetchLiveDeployment(
  deployment: NetworkDeployment,
  network: DeploymentNetwork
): Promise<LiveDeploymentSnapshot> {
  const server = new rpc.Server(STELLAR_NETWORKS[network].rpcUrl, {
    timeout: 20_000,
  });
  const [vault, blendAdapter, defindexAdapter, musdc] = await Promise.all([
    fetchContractSnapshot(server, deployment.vault.address),
    fetchContractSnapshot(server, deployment.blendAdapter.address),
    deployment.defindexAdapter
      ? fetchContractSnapshot(server, deployment.defindexAdapter.address)
      : Promise.resolve(null),
    fetchContractSnapshot(server, deployment.musdc.address),
  ]);
  return { vault, blendAdapter, defindexAdapter, musdc };
}

async function verifyLiveState(manifest: DeploymentManifest): Promise<void> {
  let failed = false;
  for (const network of DEPLOYMENT_NETWORKS) {
    console.log("Reading live " + network + " deployment...");
    const live = await fetchLiveDeployment(
      manifest.contracts[network],
      network
    );
    const mismatches = deploymentStateMismatches(
      manifest.contracts[network],
      live
    );
    if (mismatches.length === 0) {
      console.log(
        "  OK: bytecode, wiring, admin, treasury, and pause state match."
      );
      continue;
    }
    failed = true;
    console.error("  " + network + " deployment drift:");
    for (const mismatch of mismatches) {
      console.error("    - " + mismatch);
    }
  }
  if (failed) {
    throw new Error("Live deployment verification failed");
  }
}

function builtContracts(
  deployment: NetworkDeployment
): Array<{ label: string; path: string; expectedHash: string }> {
  const contracts = [
    {
      label: "vault",
      path: join(BUILD_DIR, "meridian_vault.wasm"),
      expectedHash: deployment.vault.wasmHash,
    },
    {
      label: "Blend adapter",
      path: join(BUILD_DIR, "meridian_blend_adapter.wasm"),
      expectedHash: deployment.blendAdapter.wasmHash,
    },
    {
      label: "mUSDC",
      path: join(BUILD_DIR, "meridian_musdc_token.wasm"),
      expectedHash: deployment.musdc.wasmHash,
    },
  ];
  if (deployment.defindexAdapter) {
    contracts.push({
      label: "DeFindex adapter",
      path: join(BUILD_DIR, "meridian_defindex_adapter.wasm"),
      expectedHash: deployment.defindexAdapter.wasmHash,
    });
  }
  return contracts;
}

function verifyBuiltBytecode(
  manifest: DeploymentManifest,
  networks: DeploymentNetwork[]
): void {
  console.log("Building contracts from source...");
  execFileSync("stellar", ["contract", "build"], {
    cwd: CONTRACTS_DIR,
    stdio: "inherit",
  });

  let failed = false;
  for (const network of networks) {
    console.log("Checking source build for " + network + "...");
    for (const contract of builtContracts(manifest.contracts[network])) {
      if (!existsSync(contract.path)) {
        throw new Error("Expected built WASM not found: " + contract.path);
      }
      const builtHash = sha256(contract.path);
      if (builtHash !== contract.expectedHash) {
        failed = true;
        console.error(
          "  " +
            contract.label +
            ": expected " +
            contract.expectedHash +
            ", built " +
            builtHash
        );
      } else {
        console.log("  " + contract.label + ": " + builtHash + " (OK)");
      }
    }
  }
  if (failed) {
    throw new Error("Source-built bytecode does not match the manifest");
  }
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const decision = decide(manifest);
  const mode = process.argv.includes("--live")
    ? "live"
    : process.argv.includes("--verify-bytecode") ||
        process.argv.includes("--verify")
      ? "bytecode"
      : "plan";

  if (decision.action === "fail") {
    throw new Error(decision.message);
  }

  if (mode === "live") {
    await verifyLiveState(manifest);
    return;
  }

  console.log(decision.message);
  if (mode === "plan") {
    setOutput("needs_build", decision.action === "build" ? "true" : "false");
    return;
  }

  if (decision.action === "build") {
    verifyBuiltBytecode(manifest, decision.buildNetworks);
  } else {
    console.log("No source build required.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
