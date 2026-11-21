#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DEPLOYMENT_NETWORKS,
  deploymentManifestSchema,
  replaceNetworkDeployment,
  type DeploymentNetwork,
  type NetworkDeployment,
} from "../packages/shared/src/deployment-manifest";

const REPO_ROOT = join(__dirname, "..");
const MANIFEST_PATH = join(
  REPO_ROOT,
  "packages",
  "shared",
  "deployed-contracts.json"
);
const BUILD_MANIFEST_PATH = join(
  REPO_ROOT,
  "packages",
  "contracts",
  "wasm-hashes.json"
);

const { values } = parseArgs({
  args: process.argv
    .slice(2)
    .filter((arg, index) => index !== 0 || arg !== "--"),
  options: {
    network: { type: "string" },
    "vault-address": { type: "string" },
    "vault-hash": { type: "string" },
    "vault-salt": { type: "string" },
    "vault-tx": { type: "string" },
    "blend-address": { type: "string" },
    "blend-hash": { type: "string" },
    "blend-salt": { type: "string" },
    "blend-tx": { type: "string" },
    "defindex-address": { type: "string" },
    "defindex-hash": { type: "string" },
    "defindex-salt": { type: "string" },
    "defindex-tx": { type: "string" },
    "defindex-vault": { type: "string" },
    "musdc-address": { type: "string" },
    "musdc-hash": { type: "string" },
    "musdc-salt": { type: "string" },
    "musdc-tx": { type: "string" },
    admin: { type: "string" },
    treasury: { type: "string" },
    usdc: { type: "string" },
    "blend-pool": { type: "string" },
  },
  strict: true,
});

function required(name: keyof typeof values): string {
  const value = values[name]?.trim();
  if (!value) {
    throw new Error("Missing required --" + name + " value");
  }
  return value;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

/**
 * Verifies that the WASM hash being recorded for each contract is present in
 * the reproducible-build hash manifest (`wasm-hashes.json`), which is only
 * produced after two independent clean builds yield identical SHA-256 digests.
 * Refuses to record any hash that is not verified.
 */
function loadVerifiedWasmHashes(): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(BUILD_MANIFEST_PATH, "utf8");
  } catch {
    throw new Error(
      "Missing verified WASM hash manifest at " +
        BUILD_MANIFEST_PATH +
        ". Run the reproducible build (scripts/reproducible-build.sh) first."
    );
  }
  const parsed = JSON.parse(raw) as {
    contracts?: Record<string, { sha256?: string; verified?: boolean }>;
  };
  const verified = new Map<string, string>();
  for (const [name, entry] of Object.entries(parsed.contracts ?? {})) {
    if (entry.verified === true && entry.sha256) {
      verified.set(entry.sha256.toLowerCase(), name);
    }
  }
  return verified;
}

function assertVerifiedHash(
  verified: Map<string, string>,
  label: string,
  hash: string
): void {
  if (!verified.has(hash.toLowerCase())) {
    throw new Error(
      "Refusing to record " +
        label +
        " wasmHash " +
        hash +
        ": not present in the verified reproducible-build manifest"
    );
  }
}

function optionalDefindex(
  sourceCommit: string,
  vaultAddress: string,
  usdc: string
): NetworkDeployment["defindexAdapter"] {
  const names = [
    "defindex-address",
    "defindex-hash",
    "defindex-salt",
    "defindex-tx",
    "defindex-vault",
  ] as const;
  const present = names.filter((name) => values[name]?.trim());
  if (present.length === 0) {
    return null;
  }
  if (present.length !== names.length) {
    throw new Error(
      "DeFindex deployment metadata must be all-or-none; received " +
        present.join(", ")
    );
  }

  return {
    address: required("defindex-address"),
    wasmHash: required("defindex-hash"),
    salt: required("defindex-salt"),
    deploymentTransaction: required("defindex-tx"),
    sourceCommit,
    constructorArgs: {
      vault: vaultAddress,
      defindexVault: required("defindex-vault"),
      usdc,
    },
  };
}

function main(): void {
  const networkValue = required("network");
  if (!DEPLOYMENT_NETWORKS.includes(networkValue as DeploymentNetwork)) {
    throw new Error("Unsupported network: " + networkValue);
  }
  const network = networkValue as DeploymentNetwork;

  const dirtyContracts = git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "packages/contracts",
  ]);
  if (dirtyContracts) {
    throw new Error(
      "Refusing to record a source commit while packages/contracts has uncommitted changes"
    );
  }

  const verifiedHashes = loadVerifiedWasmHashes();

  const sourceCommit = git(["rev-parse", "HEAD"]);
  const vaultAddress = required("vault-address");
  const blendAddress = required("blend-address");
  const musdcAddress = required("musdc-address");
  const admin = required("admin");
  const treasury = required("treasury");
  const usdc = required("usdc");

  const vaultHash = required("vault-hash");
  const blendHash = required("blend-hash");
  const musdcHash = required("musdc-hash");
  assertVerifiedHash(verifiedHashes, "vault", vaultHash);
  assertVerifiedHash(verifiedHashes, "blend", blendHash);
  assertVerifiedHash(verifiedHashes, "musdc", musdcHash);
  if (values["defindex-hash"]?.trim()) {
    assertVerifiedHash(verifiedHashes, "defindex", required("defindex-hash"));
  }

  const deployment: NetworkDeployment = {
    vault: {
      address: vaultAddress,
      wasmHash: vaultHash,
      salt: required("vault-salt"),
      deploymentTransaction: required("vault-tx"),
      sourceCommit,
      constructorArgs: {
        admin,
        usdc,
        musdc: musdcAddress,
        adapter: blendAddress,
        treasury,
      },
    },
    blendAdapter: {
      address: blendAddress,
      wasmHash: blendHash,
      salt: required("blend-salt"),
      deploymentTransaction: required("blend-tx"),
      sourceCommit,
      constructorArgs: {
        vault: vaultAddress,
        pool: required("blend-pool"),
        usdc,
      },
    },
    defindexAdapter: optionalDefindex(sourceCommit, vaultAddress, usdc),
    musdc: {
      address: musdcAddress,
      wasmHash: musdcHash,
      salt: required("musdc-salt"),
      deploymentTransaction: required("musdc-tx"),
      sourceCommit,
      constructorArgs: {
        admin: vaultAddress,
        decimals: 7,
        name: "Meridian USDC",
        symbol: "mUSDC",
      },
    },
    expectedState: {
      admin,
      treasury,
      usdc,
      musdc: musdcAddress,
      activeAdapter: blendAddress,
      paused: false,
    },
  };

  const manifest = deploymentManifestSchema.parse(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
  );
  const updated = replaceNetworkDeployment(manifest, network, deployment);
  const temporaryPath = MANIFEST_PATH + "." + process.pid + ".tmp";
  writeFileSync(temporaryPath, JSON.stringify(updated, null, 2) + "\n", {
    mode: 0o644,
  });
  renameSync(temporaryPath, MANIFEST_PATH);
  console.log(
    "Updated deployment manifest for " + network + ": " + MANIFEST_PATH
  );
}

main();
