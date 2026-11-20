import { describe, expect, it } from "vitest";
import {
  deploymentManifestSchema,
  deploymentStateMismatches,
  replaceNetworkDeployment,
  type DeploymentManifest,
  type LiveDeploymentSnapshot,
} from "./deployment-manifest";

const address = (prefix: "C" | "G", fill: string) =>
  `${prefix}${fill.repeat(55)}`;

const vault = address("C", "A");
const blendAdapter = address("C", "B");
const defindexAdapter = address("C", "C");
const musdc = address("C", "D");
const usdc = address("C", "E");
const pool = address("C", "F");
const defindexVault = address("C", "G");
const admin = address("G", "A");
const hash = "a".repeat(64);

const deployment = {
  vault: {
    address: vault,
    wasmHash: hash,
    salt: null,
    deploymentTransaction: null,
    sourceCommit: null,
    constructorArgs: {
      admin,
      usdc,
      musdc,
      adapter: blendAdapter,
      treasury: null,
    },
  },
  blendAdapter: {
    address: blendAdapter,
    wasmHash: hash,
    salt: null,
    deploymentTransaction: null,
    sourceCommit: null,
    constructorArgs: { vault, pool, usdc },
  },
  defindexAdapter: null,
  musdc: {
    address: musdc,
    wasmHash: hash,
    salt: null,
    deploymentTransaction: null,
    sourceCommit: null,
    constructorArgs: {
      admin: vault,
      decimals: 7,
      name: "Meridian USDC",
      symbol: "mUSDC",
    },
  },
  expectedState: {
    admin,
    treasury: null,
    usdc,
    musdc,
    activeAdapter: blendAdapter,
    paused: false,
  },
} satisfies DeploymentManifest["contracts"]["testnet"];

const manifest = {
  version: 2,
  note: "Deployment manifest",
  toolchain: { stellarCli: "28.0.0", target: "wasm32v1-none" },
  contracts: { testnet: deployment, mainnet: deployment },
} satisfies DeploymentManifest;

const live = {
  vault: {
    wasmHash: hash,
    storage: {
      ADMIN: admin,
      USDC: usdc,
      MUSDC: musdc,
      ADAPTER: blendAdapter,
    },
  },
  blendAdapter: {
    wasmHash: hash,
    storage: { VAULT: vault, USDC: usdc, POOL: pool },
  },
  defindexAdapter: null,
  musdc: { wasmHash: hash, storage: { ADMIN: vault } },
} satisfies LiveDeploymentSnapshot;

const deploymentWithDefindex =
  (): DeploymentManifest["contracts"]["testnet"] => ({
    ...structuredClone(deployment),
    vault: {
      ...structuredClone(deployment.vault),
      constructorArgs: {
        ...deployment.vault.constructorArgs,
        adapter: defindexAdapter,
      },
    },
    defindexAdapter: {
      address: defindexAdapter,
      wasmHash: hash,
      salt: null,
      deploymentTransaction: null,
      sourceCommit: null,
      constructorArgs: { vault, defindexVault, usdc },
    },
    expectedState: {
      ...deployment.expectedState,
      activeAdapter: defindexAdapter,
    },
  });

const liveWithDefindex = (): LiveDeploymentSnapshot => ({
  ...structuredClone(live),
  vault: {
    ...structuredClone(live.vault),
    storage: { ...live.vault.storage, ADAPTER: defindexAdapter },
  },
  defindexAdapter: {
    wasmHash: hash,
    storage: { VAULT: vault, USDC: usdc, DFXVAULT: defindexVault },
  },
});

describe("deploymentManifestSchema", () => {
  it("accepts explicit nulls for unavailable legacy metadata", () => {
    expect(deploymentManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects fields that could accidentally persist secrets", () => {
    const withSecret = structuredClone(manifest) as Record<string, unknown>;
    const contracts = withSecret.contracts as Record<string, unknown>;
    const testnet = contracts.testnet as Record<string, unknown>;
    const testnetVault = testnet.vault as Record<string, unknown>;
    testnetVault.secretKey = "S...";

    expect(() => deploymentManifestSchema.parse(withSecret)).toThrow();
  });

  it("rejects contract bindings outside the recorded stack", () => {
    const inconsistent = structuredClone(manifest);
    inconsistent.contracts.testnet.blendAdapter.constructorArgs.vault = address(
      "C",
      "G"
    );

    expect(() => deploymentManifestSchema.parse(inconsistent)).toThrow(
      "Deployment relationship does not match the recorded stack"
    );
  });

  it("accepts a DeFindex adapter wired into the recorded stack", () => {
    const withDefindex = {
      ...structuredClone(manifest),
      contracts: {
        ...structuredClone(manifest.contracts),
        testnet: deploymentWithDefindex(),
      },
    } satisfies DeploymentManifest;

    expect(deploymentManifestSchema.parse(withDefindex)).toEqual(withDefindex);
  });

  it("rejects an active adapter that is not recorded in the deployment", () => {
    const inconsistent = structuredClone(manifest);
    const unknownAdapter = address("C", "H");
    inconsistent.contracts.testnet.vault.constructorArgs.adapter =
      unknownAdapter;
    inconsistent.contracts.testnet.expectedState.activeAdapter = unknownAdapter;

    expect(() => deploymentManifestSchema.parse(inconsistent)).toThrow(
      "Active adapter is not recorded in this deployment"
    );
  });

  it.each([
    ["admin", address("G", "B")],
    ["adapter", address("C", "G")],
  ] as const)(
    "rejects a vault constructor %s that differs from expected live state",
    (field, value) => {
      const inconsistent = structuredClone(manifest);
      inconsistent.contracts.testnet.vault.constructorArgs[field] = value;

      expect(() => deploymentManifestSchema.parse(inconsistent)).toThrow(
        "Deployment relationship does not match the recorded stack"
      );
    }
  );
});

describe("deploymentStateMismatches", () => {
  it("accepts matching live wiring and treats an absent PAUSED key as false", () => {
    expect(deploymentStateMismatches(deployment, live)).toEqual([]);
  });

  it("reports bytecode and relationship drift", () => {
    const drifted = structuredClone(live);
    drifted.vault.storage.ADAPTER = address("C", "G");
    drifted.blendAdapter.storage.USDC = address("C", "H");
    drifted.musdc.wasmHash = "b".repeat(64);

    expect(deploymentStateMismatches(deployment, drifted)).toEqual([
      `vault.activeAdapter: expected ${blendAdapter}, found ${address("C", "G")}`,
      `blendAdapter.usdc: expected ${usdc}, found ${address("C", "H")}`,
      `musdc.wasmHash: expected ${hash}, found ${"b".repeat(64)}`,
    ]);
  });

  it("reports an unexpected live DeFindex deployment", () => {
    expect(deploymentStateMismatches(deployment, liveWithDefindex())).toContain(
      "defindexAdapter: expected no deployment, found one"
    );
  });

  it("reports a missing live DeFindex deployment", () => {
    expect(deploymentStateMismatches(deploymentWithDefindex(), live)).toContain(
      "defindexAdapter: expected a deployment, found none"
    );
  });

  it("accepts matching live DeFindex state", () => {
    expect(
      deploymentStateMismatches(deploymentWithDefindex(), liveWithDefindex())
    ).toEqual([]);
  });
});

describe("replaceNetworkDeployment", () => {
  it("replaces only the requested network and validates the result", () => {
    const replacement = deploymentWithDefindex();

    expect(replaceNetworkDeployment(manifest, "testnet", replacement)).toEqual({
      ...manifest,
      contracts: { testnet: replacement, mainnet: deployment },
    });
  });
});
