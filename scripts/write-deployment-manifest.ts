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

  const sourceCommit = git(["rev-parse", "HEAD"]);
  const vaultAddress = required("vault-address");
  const blendAddress = required("blend-address");
  const musdcAddress = required("musdc-address");
  const admin = required("admin");
  const treasury = required("treasury");
  const usdc = required("usdc");

  const deployment: NetworkDeployment = {
    vault: {
      address: vaultAddress,
      wasmHash: required("vault-hash"),
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
      wasmHash: required("blend-hash"),
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
      wasmHash: required("musdc-hash"),
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
