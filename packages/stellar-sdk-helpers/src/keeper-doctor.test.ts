import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { runKeeperDoctor } from "./keeper-doctor";
import {
  runMigrationKeeper,
  type MigrationKeeperConfig,
} from "./migration-keeper";
import {
  createInMemoryKeeperStateStore,
  type KeeperStateStore,
} from "./keeper-state";
import type { KnownPoolMeta } from "./known-pools";
import type { StellarNetwork } from "./types";

const TEST_NETWORK: StellarNetwork = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};

const VALID_KEYPAIR = Keypair.random();
const VALID_SECRET = VALID_KEYPAIR.secret();
const VALID_PUBLIC = VALID_KEYPAIR.publicKey();
const OTHER_PUBLIC = Keypair.random().publicKey();

// Valid StrKey contract IDs (C + 55 base32 chars, valid CRC16 checksums).
const VALID_VAULT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_ADAPTER_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

const TEST_POOLS: Record<string, KnownPoolMeta> = {
  "meridian-usdc": {
    id: "meridian-usdc",
    name: "Meridian USDC Vault",
    label: "USDC Vault",
    protocol: "meridian",
    contractId: VALID_VAULT_ID,
    asset: "USDC",
  },
};

function makeHealthyServer() {
  return {
    getHealth: vi.fn(async () => ({ status: "healthy", latestLedger: 12345 })),
  };
}

function makeBaseEnv(): Record<string, string | undefined> {
  return {
    MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: VALID_SECRET,
    MERIDIAN_ADAPTER_BLEND_ID: VALID_ADAPTER_ID,
    MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS: "100",
    MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS: "50",
  };
}

function makeSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("runKeeperDoctor", () => {
  it("passes all 6 checks when migration keeper is properly configured", async () => {
    const report = await runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 25.5),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("pass");
    expect(report.signerPublicKey).toBe(VALID_PUBLIC);
    expect(report.blockedReasons).toEqual([]);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(VALID_SECRET);
  });

  it("passes for accrual keeper without requiring vault admin match", async () => {
    const simulate = vi.fn();
    const report = await runKeeperDoctor({
      keeper: "accrual",
      env: { MERIDIAN_KEEPER_SECRET_KEY: VALID_SECRET },
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate,
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("pass");
    expect(simulate).not.toHaveBeenCalled();
    expect(
      report.checks.find((c) => c.id === "vault_admin_match")?.status
    ).toBe("pass");
  });

  it("fails signer_derivation and blocks dependent checks when secret key is invalid, never leaking secret", async () => {
    const badSecret = "SBADSECRETKEYTHATSHOULDNEVERAPPEARINANYOUTPUT1234567890";
    const logger = makeSilentLogger();
    const report = await runKeeperDoctor({
      keeper: "migration",
      env: {
        ...makeBaseEnv(),
        MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: badSecret,
      },
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger,
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe("fail");
    expect(report.signerPublicKey).toBeUndefined();

    const signerCheck = report.checks.find((c) => c.id === "signer_derivation");
    expect(signerCheck?.status).toBe("fail");
    expect(signerCheck?.remediation).toBeTruthy();

    expect(
      report.checks.find((c) => c.id === "vault_admin_match")?.status
    ).toBe("blocked");
    expect(report.checks.find((c) => c.id === "fee_balance")?.status).toBe(
      "blocked"
    );
    expect(report.blockedReasons.length).toBeGreaterThanOrEqual(3);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(badSecret);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(badSecret);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(badSecret);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(badSecret);
  });

  it("fails rpc_reachability and blocks vault_admin_match when RPC is unreachable", async () => {
    const report = await runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: {
        getHealth: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      },
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(false);
    const rpcCheck = report.checks.find((c) => c.id === "rpc_reachability");
    expect(rpcCheck?.status).toBe("fail");
    expect(rpcCheck?.remediation).toBeTruthy();

    const adminCheck = report.checks.find((c) => c.id === "vault_admin_match");
    expect(adminCheck?.status).toBe("blocked");
    expect(adminCheck?.remediation).toBeTruthy();
  });

  it("fails vault_admin_match when on-chain vault admin differs from signer", async () => {
    const report = await runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => OTHER_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(false);
    const adminCheck = report.checks.find((c) => c.id === "vault_admin_match");
    expect(adminCheck?.status).toBe("fail");
    expect(adminCheck?.remediation).toBeTruthy();
    expect(adminCheck?.details).toMatchObject({
      mismatched: [
        {
          vaultId: "meridian-usdc",
          onChainAdmin: OTHER_PUBLIC,
          signerPublicKey: VALID_PUBLIC,
        },
      ],
    });
  });

  it("fails state_store_access when state store probe throws", async () => {
    const brokenStore: KeeperStateStore = {
      get: vi.fn(async () => {
        throw new Error(`Redis auth failed for ${VALID_SECRET}`);
      }),
      claim: vi.fn(),
      replace: vi.fn(),
      deleteIf: vi.fn(),
    };

    const report = await runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: brokenStore,
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(false);
    const storeCheck = report.checks.find((c) => c.id === "state_store_access");
    expect(storeCheck?.status).toBe("fail");
    expect(storeCheck?.remediation).toBeTruthy();
    expect(JSON.stringify(report)).not.toContain(VALID_SECRET);
  });

  it("fails state_store_access on deployed env without shared Upstash Redis", async () => {
    const report = await runKeeperDoctor({
      keeper: "migration",
      env: {
        ...makeBaseEnv(),
        VERCEL_ENV: "production",
      },
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(false);
    const storeCheck = report.checks.find((c) => c.id === "state_store_access");
    expect(storeCheck?.status).toBe("fail");
    expect(storeCheck?.remediation).toContain("UPSTASH_REDIS_REST_URL");
  });

  it("fails fee_balance when signer account is missing or underfunded", async () => {
    const unfunded = await runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 0.2),
      minFeeBalanceXlm: 1,
      logger: makeSilentLogger(),
    });

    expect(unfunded.ok).toBe(false);
    const feeCheck = unfunded.checks.find((c) => c.id === "fee_balance");
    expect(feeCheck?.status).toBe("fail");
    expect(feeCheck?.remediation).toBeTruthy();

    const missing = await runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => null),
      logger: makeSilentLogger(),
    });
    expect(missing.checks.find((c) => c.id === "fee_balance")?.status).toBe(
      "fail"
    );
  });

  it("fails strategy_configuration when candidate adapters are missing or invalid", async () => {
    const noAdapters = await runKeeperDoctor({
      keeper: "migration",
      env: {
        MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: VALID_SECRET,
      },
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(noAdapters.ok).toBe(false);
    const strategyCheck = noAdapters.checks.find(
      (c) => c.id === "strategy_configuration"
    );
    expect(strategyCheck?.status).toBe("fail");
    expect(strategyCheck?.remediation).toBeTruthy();
  });
});

describe("runMigrationKeeper preflight integration", () => {
  it("returns a blocked result and never attempts discovery or submission when preflight fails", async () => {
    const discoverVaults = vi.fn();
    const submitMigration = vi.fn();
    const logger = makeSilentLogger();

    const config: MigrationKeeperConfig = {
      network: TEST_NETWORK,
      secretKey: VALID_SECRET,
      maxAttempts: 3,
      baseDelayMs: 10,
      rpcTimeoutMs: 1_000,
      minImprovementBps: 50,
      maxSlippageBps: 100,
      submissionTtlMs: 360_000,
      candidateAdapters: { blend: VALID_ADAPTER_ID },
    };

    const result = await runMigrationKeeper(config, {
      discoverVaults,
      submitMigration,
      logger,
      preflight: async () => ({
        keeper: "migration",
        network: "testnet",
        checkedAt: "2026-11-20T00:00:00.000Z",
        status: "fail",
        ok: false,
        checks: [
          {
            id: "vault_admin_match",
            status: "fail",
            summary: "Signer does not match vault admin",
            remediation: "Use the vault admin secret key.",
          },
        ],
        blockedReasons: [
          "vault_admin_match: Signer does not match vault admin (Use the vault admin secret key.)",
        ],
      }),
    });

    expect(result.blocked).toBe(true);
    expect(result.blockedReasons).toHaveLength(1);
    expect(result.preflight?.ok).toBe(false);
    expect(result.discoveredVaults).toBe(0);
    expect(result.migrations).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(discoverVaults).not.toHaveBeenCalled();
    expect(submitMigration).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(VALID_SECRET);
  });
});
