import { z } from "zod";

export const DEPLOYMENT_NETWORKS = ["testnet", "mainnet"] as const;

const addressSchema = z.string().regex(/^[CG][A-Z2-7]{55}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const sourceCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40,64}$/)
  .nullable();
const legacyMetadataSchema = z
  .object({
    salt: hashSchema.nullable(),
    deploymentTransaction: hashSchema.nullable(),
    sourceCommit: sourceCommitSchema,
  })
  .strict();

const vaultSchema = legacyMetadataSchema.extend({
  address: addressSchema,
  wasmHash: hashSchema,
  constructorArgs: z
    .object({
      admin: addressSchema,
      usdc: addressSchema,
      musdc: addressSchema,
      adapter: addressSchema,
      treasury: addressSchema.nullable(),
    })
    .strict(),
});

const blendAdapterSchema = legacyMetadataSchema.extend({
  address: addressSchema,
  wasmHash: hashSchema,
  constructorArgs: z
    .object({
      vault: addressSchema,
      pool: addressSchema,
      usdc: addressSchema,
    })
    .strict(),
});

const defindexAdapterSchema = legacyMetadataSchema.extend({
  address: addressSchema,
  wasmHash: hashSchema,
  constructorArgs: z
    .object({
      vault: addressSchema,
      defindexVault: addressSchema,
      usdc: addressSchema,
    })
    .strict(),
});

const musdcSchema = legacyMetadataSchema.extend({
  address: addressSchema,
  wasmHash: hashSchema,
  constructorArgs: z
    .object({
      admin: addressSchema,
      decimals: z.number().int().nonnegative(),
      name: z.string().min(1),
      symbol: z.string().min(1),
    })
    .strict(),
});

const deploymentSchema = z
  .object({
    vault: vaultSchema,
    blendAdapter: blendAdapterSchema,
    defindexAdapter: defindexAdapterSchema.nullable(),
    musdc: musdcSchema,
    expectedState: z
      .object({
        admin: addressSchema,
        treasury: addressSchema.nullable(),
        usdc: addressSchema,
        musdc: addressSchema,
        activeAdapter: addressSchema,
        paused: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((deployment, context) => {
    const relationships: Array<{
      path: (string | number)[];
      actual: string | null;
      expected: string | null;
    }> = [
      {
        path: ["vault", "constructorArgs", "admin"],
        actual: deployment.vault.constructorArgs.admin,
        expected: deployment.expectedState.admin,
      },
      {
        path: ["vault", "constructorArgs", "usdc"],
        actual: deployment.vault.constructorArgs.usdc,
        expected: deployment.expectedState.usdc,
      },
      {
        path: ["vault", "constructorArgs", "musdc"],
        actual: deployment.vault.constructorArgs.musdc,
        expected: deployment.musdc.address,
      },
      {
        path: ["vault", "constructorArgs", "treasury"],
        actual: deployment.vault.constructorArgs.treasury,
        expected: deployment.expectedState.treasury,
      },
      {
        path: ["vault", "constructorArgs", "adapter"],
        actual: deployment.vault.constructorArgs.adapter,
        expected: deployment.expectedState.activeAdapter,
      },
      {
        path: ["blendAdapter", "constructorArgs", "vault"],
        actual: deployment.blendAdapter.constructorArgs.vault,
        expected: deployment.vault.address,
      },
      {
        path: ["blendAdapter", "constructorArgs", "usdc"],
        actual: deployment.blendAdapter.constructorArgs.usdc,
        expected: deployment.expectedState.usdc,
      },
      {
        path: ["musdc", "constructorArgs", "admin"],
        actual: deployment.musdc.constructorArgs.admin,
        expected: deployment.vault.address,
      },
    ];
    if (deployment.defindexAdapter) {
      relationships.push(
        {
          path: ["defindexAdapter", "constructorArgs", "vault"],
          actual: deployment.defindexAdapter.constructorArgs.vault,
          expected: deployment.vault.address,
        },
        {
          path: ["defindexAdapter", "constructorArgs", "usdc"],
          actual: deployment.defindexAdapter.constructorArgs.usdc,
          expected: deployment.expectedState.usdc,
        }
      );
    }

    for (const relationship of relationships) {
      if (relationship.actual !== relationship.expected) {
        context.addIssue({
          code: "custom",
          path: relationship.path,
          message: "Deployment relationship does not match the recorded stack",
        });
      }
    }

    const adapterAddresses = [
      deployment.blendAdapter.address,
      deployment.defindexAdapter?.address,
    ];
    if (!adapterAddresses.includes(deployment.expectedState.activeAdapter)) {
      context.addIssue({
        code: "custom",
        path: ["expectedState", "activeAdapter"],
        message: "Active adapter is not recorded in this deployment",
      });
    }
  });

const contractBuildSchema = z
  .object({
    name: z.string().min(1),
    sha256: hashSchema,
  })
  .strict();

export const buildManifestSchema = z
  .object({
    version: z.literal(1),
    compiler: z
      .object({
        rustc: z.string().min(1),
        stellarCli: z.string().min(1),
        sorobanSdk: z.string().min(1),
        target: z.literal("wasm32v1-none"),
      })
      .strict(),
    sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    contracts: z.array(contractBuildSchema).length(5),
  })
  .strict();

export const deploymentManifestSchema = z
  .object({
    version: z.literal(2),
    note: z.string().min(1),
    toolchain: z
      .object({
        stellarCli: z.string().min(1),
        target: z.literal("wasm32v1-none"),
      })
      .strict(),
    contracts: z
      .object({
        testnet: deploymentSchema,
        mainnet: deploymentSchema,
      })
      .strict(),
  })
  .strict();

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type BuildManifest = z.infer<typeof buildManifestSchema>;
export type DeploymentNetwork = (typeof DEPLOYMENT_NETWORKS)[number];
export type NetworkDeployment =
  DeploymentManifest["contracts"][DeploymentNetwork];

export interface LiveContractSnapshot {
  wasmHash: string;
  storage: Record<string, string | number | boolean>;
}

export interface LiveDeploymentSnapshot {
  vault: LiveContractSnapshot;
  blendAdapter: LiveContractSnapshot;
  defindexAdapter: LiveContractSnapshot | null;
  musdc: LiveContractSnapshot;
}

function compare(
  mismatches: string[],
  label: string,
  actual: string | number | boolean | undefined,
  expected: string | number | boolean | null
): void {
  const normalizedActual = actual ?? null;
  if (normalizedActual !== expected) {
    mismatches.push(
      `${label}: expected ${String(expected)}, found ${String(normalizedActual)}`
    );
  }
}

function compareContract(
  mismatches: string[],
  label: string,
  snapshot: LiveContractSnapshot,
  expectedHash: string
): void {
  compare(mismatches, `${label}.wasmHash`, snapshot.wasmHash, expectedHash);
}

export function deploymentStateMismatches(
  deployment: NetworkDeployment,
  live: LiveDeploymentSnapshot
): string[] {
  const mismatches: string[] = [];

  compareContract(mismatches, "vault", live.vault, deployment.vault.wasmHash);
  compare(
    mismatches,
    "vault.admin",
    live.vault.storage.ADMIN,
    deployment.expectedState.admin
  );
  compare(
    mismatches,
    "vault.treasury",
    live.vault.storage.TREASURY,
    deployment.expectedState.treasury
  );
  compare(
    mismatches,
    "vault.usdc",
    live.vault.storage.USDC,
    deployment.expectedState.usdc
  );
  compare(
    mismatches,
    "vault.musdc",
    live.vault.storage.MUSDC,
    deployment.expectedState.musdc
  );
  compare(
    mismatches,
    "vault.activeAdapter",
    live.vault.storage.ADAPTER,
    deployment.expectedState.activeAdapter
  );
  compare(
    mismatches,
    "vault.paused",
    live.vault.storage.PAUSED ?? false,
    deployment.expectedState.paused
  );

  compareContract(
    mismatches,
    "blendAdapter",
    live.blendAdapter,
    deployment.blendAdapter.wasmHash
  );
  compare(
    mismatches,
    "blendAdapter.vault",
    live.blendAdapter.storage.VAULT,
    deployment.vault.address
  );
  compare(
    mismatches,
    "blendAdapter.usdc",
    live.blendAdapter.storage.USDC,
    deployment.expectedState.usdc
  );
  compare(
    mismatches,
    "blendAdapter.pool",
    live.blendAdapter.storage.POOL,
    deployment.blendAdapter.constructorArgs.pool
  );

  if (deployment.defindexAdapter === null) {
    if (live.defindexAdapter !== null) {
      mismatches.push("defindexAdapter: expected no deployment, found one");
    }
  } else if (live.defindexAdapter === null) {
    mismatches.push("defindexAdapter: expected a deployment, found none");
  } else {
    compareContract(
      mismatches,
      "defindexAdapter",
      live.defindexAdapter,
      deployment.defindexAdapter.wasmHash
    );
    compare(
      mismatches,
      "defindexAdapter.vault",
      live.defindexAdapter.storage.VAULT,
      deployment.vault.address
    );
    compare(
      mismatches,
      "defindexAdapter.usdc",
      live.defindexAdapter.storage.USDC,
      deployment.expectedState.usdc
    );
    compare(
      mismatches,
      "defindexAdapter.defindexVault",
      live.defindexAdapter.storage.DFXVAULT,
      deployment.defindexAdapter.constructorArgs.defindexVault
    );
  }

  compareContract(mismatches, "musdc", live.musdc, deployment.musdc.wasmHash);
  compare(
    mismatches,
    "musdc.admin",
    live.musdc.storage.ADMIN,
    deployment.vault.address
  );

  return mismatches;
}

export function replaceNetworkDeployment(
  manifest: DeploymentManifest,
  network: DeploymentNetwork,
  deployment: NetworkDeployment
): DeploymentManifest {
  return deploymentManifestSchema.parse({
    ...manifest,
    contracts: {
      ...manifest.contracts,
      [network]: deployment,
    },
  });
}

/**
 * Compares two build manifests produced from independent clean builds of the
 * same commit. Returns human-readable mismatch descriptions; an empty array
 * means the builds are byte-for-byte reproducible.
 */
export function buildReproducibilityMismatches(
  first: BuildManifest,
  second: BuildManifest
): string[] {
  const mismatches: string[] = [];
  compare(
    mismatches,
    "compiler.rustc",
    second.compiler.rustc,
    first.compiler.rustc
  );
  compare(
    mismatches,
    "compiler.stellarCli",
    second.compiler.stellarCli,
    first.compiler.stellarCli
  );
  compare(
    mismatches,
    "compiler.sorobanSdk",
    second.compiler.sorobanSdk,
    first.compiler.sorobanSdk
  );
  compare(
    mismatches,
    "sourceCommit",
    second.sourceCommit,
    first.sourceCommit
  );

  const secondByName = new Map(second.contracts.map((c) => [c.name, c.sha256]));
  for (const contract of first.contracts) {
    const other = secondByName.get(contract.name);
    compare(
      mismatches,
      `${contract.name}.sha256`,
      other,
      contract.sha256
    );
  }
  return mismatches;
}

/**
 * Returns true only when the artifact hash is listed in the verified build
 * manifest. Deploy tooling must call this before using any local WASM.
 */
export function isVerifiedArtifact(
  manifest: BuildManifest,
  contractName: string,
  sha256: string
): boolean {
  return manifest.contracts.some(
    (contract) =>
      contract.name === contractName && contract.sha256 === sha256
  );
}
