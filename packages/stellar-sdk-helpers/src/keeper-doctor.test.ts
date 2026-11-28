import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { runKeeperDoctor } from "./keeper-doctor";
import { buildHorizonServer } from "./horizon";
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

vi.mock("./horizon", () => ({ buildHorizonServer: vi.fn() }));

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

  it("falls back to KEEPER_SECRET_KEY for accrual keeper when MERIDIAN_KEEPER_SECRET_KEY is unset", async () => {
    const report = await runKeeperDoctor({
      keeper: "accrual",
      env: { KEEPER_SECRET_KEY: VALID_SECRET },
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(),
      stateStore: createInMemoryKeeperStateStore(),
      loadFeeBalanceXlm: vi.fn(async () => 10),
      logger: makeSilentLogger(),
    });

    expect(report.ok).toBe(true);
    expect(report.signerPublicKey).toBe(VALID_PUBLIC);
    expect(
      report.checks.find((c) => c.id === "signer_derivation")?.status
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

describe("runKeeperDoctor edge cases", () => {
  const base = () => ({
    keeper: "migration" as const,
    env: makeBaseEnv(),
    network: TEST_NETWORK,
    pools: TEST_POOLS,
    server: makeHealthyServer(),
    simulate: vi.fn(async () => VALID_PUBLIC),
    stateStore: createInMemoryKeeperStateStore(),
    loadFeeBalanceXlm: vi.fn(async () => 25.5),
    logger: makeSilentLogger(),
  });
  const check = (
    report: Awaited<ReturnType<typeof runKeeperDoctor>>,
    id: string
  ) => report.checks.find((c) => c.id === id);

  it("fails the rpc check when the server reports an unhealthy status", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      server: { getHealth: vi.fn(async () => ({ status: "unhealthy" })) },
    });

    expect(check(report, "rpc_reachability")?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("falls back to getLatestLedger when getHealth is absent", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      server: { getLatestLedger: vi.fn(async () => ({ sequence: 77 })) },
    });

    expect(check(report, "rpc_reachability")).toMatchObject({
      status: "pass",
      details: { latestLedger: 77 },
    });
  });

  it("fails the rpc check when the client exposes neither health call", async () => {
    const report = await runKeeperDoctor({ ...base(), server: {} });

    expect(check(report, "rpc_reachability")?.status).toBe("fail");
  });

  it("fails the rpc check when the health call throws", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      server: {
        getHealth: vi.fn(async () => {
          throw new Error("connect ECONNREFUSED");
        }),
      },
    });

    expect(check(report, "rpc_reachability")?.status).toBe("fail");
  });

  it("fails the state store check when the store read throws", async () => {
    const store = createInMemoryKeeperStateStore();
    store.get = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const report = await runKeeperDoctor({ ...base(), stateStore: store });

    expect(check(report, "state_store_access")?.status).toBe("fail");
  });

  it("fails the fee check when the signer account does not exist", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      loadFeeBalanceXlm: vi.fn(async () => null),
    });

    expect(check(report, "fee_balance")).toMatchObject({
      status: "fail",
      summary: "Signer account does not exist on-chain",
    });
  });

  it("fails the fee check when the balance is below the minimum", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      minFeeBalanceXlm: 5,
      loadFeeBalanceXlm: vi.fn(async () => 2),
    });

    expect(check(report, "fee_balance")?.status).toBe("fail");
  });

  it("reads the minimum balance from the environment and ignores bad values", async () => {
    const fromEnv = await runKeeperDoctor({
      ...base(),
      env: { ...makeBaseEnv(), MERIDIAN_KEEPER_MIN_XLM_BALANCE: "30" },
    });
    const invalid = await runKeeperDoctor({
      ...base(),
      env: { ...makeBaseEnv(), MERIDIAN_KEEPER_MIN_XLM_BALANCE: "lots" },
    });

    expect(check(fromEnv, "fee_balance")?.status).toBe("fail");
    expect(check(invalid, "fee_balance")?.status).toBe("pass");
  });

  it("redacts the signer secret from error details", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      loadFeeBalanceXlm: vi.fn(async () => {
        throw new Error("Horizon rejected " + VALID_SECRET);
      }),
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(VALID_SECRET);
    expect(check(report, "fee_balance")?.status).toBe("fail");
  });

  it("blocks the fee check when the signer secret is missing", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      env: { ...makeBaseEnv(), MERIDIAN_MIGRATION_KEEPER_SECRET_KEY: "" },
    });

    expect(check(report, "signer_derivation")?.status).toBe("fail");
    expect(check(report, "fee_balance")?.status).toBe("blocked");
  });

  it("rejects an invalid retry configuration", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      strategyConfig: { maxAttempts: 0, baseDelayMs: 0, rpcTimeoutMs: 0 },
    });

    expect(check(report, "strategy_configuration")?.status).toBe("fail");
  });

  it("checks the accrual keeper with its own secret variable", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      keeper: "accrual",
      env: { MERIDIAN_KEEPER_SECRET_KEY: VALID_SECRET },
    });

    expect(check(report, "signer_derivation")?.status).toBe("pass");
  });
});

describe("runKeeperDoctor vault admin and strategy checks", () => {
  const base = () => ({
    keeper: "migration" as const,
    env: makeBaseEnv(),
    network: TEST_NETWORK,
    pools: TEST_POOLS,
    server: makeHealthyServer(),
    simulate: vi.fn(async () => VALID_PUBLIC),
    stateStore: createInMemoryKeeperStateStore(),
    loadFeeBalanceXlm: vi.fn(async () => 25.5),
    logger: makeSilentLogger(),
  });
  const check = (
    report: Awaited<ReturnType<typeof runKeeperDoctor>>,
    id: string
  ) => report.checks.find((c) => c.id === id);

  it("fails when no Meridian vault is configured for the network", async () => {
    const report = await runKeeperDoctor({ ...base(), pools: {} });

    expect(check(report, "vault_admin_match")?.status).toBe("fail");
  });

  it("fails when the signer is not the on-chain admin", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      simulate: vi.fn(async () => OTHER_PUBLIC),
    });

    expect(check(report, "vault_admin_match")).toMatchObject({
      status: "fail",
      details: { mismatched: [{ onChainAdmin: OTHER_PUBLIC }] },
    });
  });

  it("fails when the on-chain admin cannot be read", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      simulate: vi.fn(async () => {
        throw new Error("simulation failed for " + VALID_SECRET);
      }),
    });

    expect(check(report, "vault_admin_match")?.status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain(VALID_SECRET);
  });

  it("blocks the admin check when the rpc check fails", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      server: { getHealth: vi.fn(async () => ({ status: "down" })) },
    });

    expect(check(report, "vault_admin_match")?.status).toBe("blocked");
  });

  it("rejects an out of range slippage and a short submission ttl", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      strategyConfig: {
        maxSlippageBps: 100_000,
        submissionTtlMs: 1,
      },
    });

    expect(check(report, "strategy_configuration")?.status).toBe("fail");
  });

  it("reports an unparseable retry setting as a configuration failure", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      env: { ...makeBaseEnv(), MERIDIAN_KEEPER_MAX_ATTEMPTS: "many" },
    });

    expect(check(report, "strategy_configuration")?.status).toBe("fail");
  });

  it("rejects a candidate adapter that is not a contract id", async () => {
    const report = await runKeeperDoctor({
      ...base(),
      env: { ...makeBaseEnv(), MERIDIAN_ADAPTER_BLEND_ID: "not-a-contract" },
    });

    expect(check(report, "strategy_configuration")?.status).toBe("fail");
  });
});

describe("runKeeperDoctor default Horizon balance loader", () => {
  const run = (loadAccount: () => Promise<unknown>) => {
    vi.mocked(buildHorizonServer).mockReturnValue({ loadAccount } as never);
    return runKeeperDoctor({
      keeper: "migration",
      env: makeBaseEnv(),
      network: TEST_NETWORK,
      pools: TEST_POOLS,
      server: makeHealthyServer(),
      simulate: vi.fn(async () => VALID_PUBLIC),
      stateStore: createInMemoryKeeperStateStore(),
      logger: makeSilentLogger(),
    });
  };
  const fee = (report: Awaited<ReturnType<typeof runKeeperDoctor>>) =>
    report.checks.find((c) => c.id === "fee_balance");

  it("reads the native balance from Horizon", async () => {
    const report = await run(async () => ({
      balances: [
        { asset_type: "credit_alphanum4", balance: "999" },
        { asset_type: "native", balance: "12.5" },
      ],
    }));

    expect(fee(report)).toMatchObject({
      status: "pass",
      details: { balanceXlm: 12.5 },
    });
  });

  it("treats an account without a native balance as empty", async () => {
    const report = await run(async () => ({ balances: [] }));

    expect(fee(report)?.status).toBe("fail");
  });

  it("treats an unparseable native balance as zero", async () => {
    const report = await run(async () => ({
      balances: [{ asset_type: "native", balance: "not-a-number" }],
    }));

    expect(fee(report)?.status).toBe("fail");
  });

  it("reports a missing account when Horizon answers 404", async () => {
    const report = await run(async () => {
      throw Object.assign(new Error("not found"), {
        response: { status: 404 },
      });
    });

    expect(fee(report)).toMatchObject({
      status: "fail",
      summary: "Signer account does not exist on-chain",
    });
  });

  it("reports a Horizon failure that is not a 404", async () => {
    const report = await run(async () => {
      throw Object.assign(new Error("bad gateway"), {
        response: { status: 502 },
      });
    });

    expect(fee(report)).toMatchObject({
      status: "fail",
      summary: "Failed to check signer XLM fee balance",
    });
  });
});
