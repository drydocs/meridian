// Preflight doctor for Meridian keepers.
//
// Validates signer derivation, RPC reachability, on-chain vault admin match,
// state-store access, signer XLM fee balance, and strategy configuration
// before a keeper run attempts any on-chain transaction.
//
// Never logs or returns secret material: all error messages and check details
// are sanitized so secret keys, RPC URLs with embedded tokens, or raw secrets
// cannot leak into logs, CLI output, or HTTP responses.

import { Horizon, Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  APP_NETWORK,
  MAX_ADMIN_SLIPPAGE_BPS,
  MIGRATION_DEFAULT_SLIPPAGE_BPS,
  withRaceTimeout,
} from "@meridian/shared";
import { buildHorizonServer } from "./horizon";
import { getRpcServer } from "./internal";
import {
  consoleLogger,
  parseNonNegativeInt,
  parsePositiveInt,
  redactedErrorMessage,
  type KeeperLogger,
} from "./keeper-retry";
import {
  loadKeeperStateStore,
  parseSubmissionTtlMs,
  submissionStateKey,
  type KeeperStateStore,
} from "./keeper-state";
import { expectString, TX_VALIDITY_WINDOW_MS } from "./keeper-tx";
import { KNOWN_POOLS, type KnownPoolMeta } from "./known-pools";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";

export type KeeperDoctorTarget = "migration" | "accrual";

export type KeeperDoctorCheckStatus = "pass" | "fail" | "blocked";

export type KeeperDoctorCheckId =
  | "signer_derivation"
  | "rpc_reachability"
  | "vault_admin_match"
  | "state_store_access"
  | "fee_balance"
  | "strategy_configuration";

export interface KeeperDoctorCheck {
  id: KeeperDoctorCheckId;
  status: KeeperDoctorCheckStatus;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export type KeeperDoctorOverallStatus = "pass" | "fail" | "blocked";

export interface KeeperDoctorReport {
  keeper: KeeperDoctorTarget;
  network: StellarNetwork["network"];
  checkedAt: string;
  status: KeeperDoctorOverallStatus;
  ok: boolean;
  /** Public key derived from the configured secret key, if derivation succeeded. */
  signerPublicKey?: string;
  checks: KeeperDoctorCheck[];
  blockedReasons: string[];
}

export interface KeeperDoctorRpcServer {
  getHealth?: () => Promise<{
    status?: string;
    latestLedger?: number;
  }>;
  getLatestLedger?: () => Promise<{ sequence?: number }>;
  simulateTransaction?: unknown;
}

export interface KeeperDoctorStrategyConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  rpcTimeoutMs?: number;
  minImprovementBps?: number;
  maxSlippageBps?: number;
  submissionTtlMs?: number;
  candidateAdapters?: Record<string, string>;
}

export interface KeeperDoctorOptions {
  keeper?: KeeperDoctorTarget;
  env?: Record<string, string | undefined>;
  network?: StellarNetwork;
  secretKey?: string;
  strategyConfig?: KeeperDoctorStrategyConfig;
  minFeeBalanceXlm?: number;
  rpcTimeoutMs?: number;
  pools?: Record<string, KnownPoolMeta>;
  server?: KeeperDoctorRpcServer;
  simulate?: typeof simulateView;
  stateStore?: KeeperStateStore;
  loadFeeBalanceXlm?: (publicKey: string) => Promise<number | null>;
  logger?: KeeperLogger;
}

const DEFAULT_MIN_FEE_BALANCE_XLM = 1;
const DEFAULT_DOCTOR_RPC_TIMEOUT_MS = 10_000;
const CANDIDATE_ADAPTER_ENV_PATTERN = /^MERIDIAN_ADAPTER_(.+)_ID$/;

function isValidContractId(id: string): boolean {
  if (typeof StrKey?.isValidContract === "function") {
    return StrKey.isValidContract(id);
  }
  return /^C[A-Z2-7]{55}$/.test(id);
}

function scrubSecret(text: string, secretKey?: string): string {
  let sanitized = text;
  if (secretKey && secretKey.length > 0) {
    sanitized = sanitized.split(secretKey).join("[REDACTED]");
  }
  // Redact anything shaped like a Stellar Ed25519 secret seed (S + 55 base32 chars).
  return sanitized.replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED]");
}

function parseMinFeeBalanceXlm(
  env: Record<string, string | undefined>,
  explicit?: number
): number {
  if (explicit !== undefined) return explicit;
  const raw = env.MERIDIAN_KEEPER_MIN_XLM_BALANCE?.trim();
  if (!raw) return DEFAULT_MIN_FEE_BALANCE_XLM;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MIN_FEE_BALANCE_XLM;
  }
  return parsed;
}

function defaultLoadFeeBalanceXlm(
  network: StellarNetwork,
  timeoutMs: number
): (publicKey: string) => Promise<number | null> {
  return async (publicKey: string) => {
    const horizon: Horizon.Server = buildHorizonServer(network);
    try {
      const account = await withRaceTimeout(
        () => horizon.loadAccount(publicKey),
        timeoutMs,
        "Horizon"
      );
      const native = account.balances.find((b) => b.asset_type === "native");
      if (!native || typeof native.balance !== "string") return 0;
      const parsed = Number(native.balance);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (err) {
      const status =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { status?: unknown } }).response?.status ===
          "number"
          ? (err as { response: { status: number } }).response.status
          : undefined;
      if (status === 404) return null;
      throw err;
    }
  };
}

function checkSignerDerivation(
  keeper: KeeperDoctorTarget,
  secretKey: string | undefined
): { check: KeeperDoctorCheck; publicKey?: string } {
  const envVar =
    keeper === "migration"
      ? "MERIDIAN_MIGRATION_KEEPER_SECRET_KEY"
      : "MERIDIAN_KEEPER_SECRET_KEY";
  const trimmed = secretKey?.trim();
  if (!trimmed) {
    return {
      check: {
        id: "signer_derivation",
        status: "fail",
        summary: `Signer secret key (${envVar}) is not configured`,
        remediation: `Set ${envVar} to a valid Stellar Ed25519 secret key (starts with S, 56 characters).`,
      },
    };
  }
  try {
    const keypair = Keypair.fromSecret(trimmed);
    const publicKey = keypair.publicKey();
    if (!publicKey || !publicKey.startsWith("G")) {
      return {
        check: {
          id: "signer_derivation",
          status: "fail",
          summary: `Derived signer public key from ${envVar} is invalid`,
          remediation: `Replace ${envVar} with a valid Stellar Ed25519 secret key.`,
        },
      };
    }
    return {
      publicKey,
      check: {
        id: "signer_derivation",
        status: "pass",
        summary: "Derived signer public key from configured secret key",
        details: { publicKey },
      },
    };
  } catch {
    return {
      check: {
        id: "signer_derivation",
        status: "fail",
        summary: `Failed to derive signer public key from ${envVar}`,
        remediation: `Replace ${envVar} with a valid Stellar Ed25519 secret key (starts with S, 56 characters).`,
      },
    };
  }
}

async function checkRpcReachability(
  server: KeeperDoctorRpcServer,
  network: StellarNetwork,
  rpcTimeoutMs: number,
  secretKey?: string
): Promise<KeeperDoctorCheck> {
  try {
    if (typeof server.getHealth === "function") {
      const health = await withRaceTimeout(
        () => server.getHealth!(),
        rpcTimeoutMs,
        "Soroban RPC"
      );
      if (
        health &&
        health.status &&
        health.status.toLowerCase() !== "healthy"
      ) {
        return {
          id: "rpc_reachability",
          status: "fail",
          summary: `Soroban RPC reported unhealthy status: ${health.status}`,
          remediation:
            "Check the configured Soroban RPC endpoint health or switch to a healthy RPC provider.",
          details: {
            network: network.network,
            rpcStatus: health.status,
          },
        };
      }
      return {
        id: "rpc_reachability",
        status: "pass",
        summary: "Soroban RPC is reachable and healthy",
        details: {
          network: network.network,
          ...(health?.latestLedger !== undefined && {
            latestLedger: health.latestLedger,
          }),
        },
      };
    }

    if (typeof server.getLatestLedger === "function") {
      const ledger = await withRaceTimeout(
        () => server.getLatestLedger!(),
        rpcTimeoutMs,
        "Soroban RPC"
      );
      return {
        id: "rpc_reachability",
        status: "pass",
        summary: "Soroban RPC is reachable",
        details: {
          network: network.network,
          ...(ledger?.sequence !== undefined && {
            latestLedger: ledger.sequence,
          }),
        },
      };
    }

    return {
      id: "rpc_reachability",
      status: "fail",
      summary: "Soroban RPC client does not expose a health or ledger check",
      remediation:
        "Ensure getRpcServer returns a Soroban RPC client with getHealth() or getLatestLedger().",
    };
  } catch (err) {
    return {
      id: "rpc_reachability",
      status: "fail",
      summary: "Soroban RPC is unreachable",
      remediation:
        "Verify network connectivity, Soroban RPC endpoint availability, and MERIDIAN_KEEPER_RPC_TIMEOUT_MS.",
      details: {
        network: network.network,
        error: scrubSecret(redactedErrorMessage(err), secretKey),
      },
    };
  }
}

async function checkVaultAdminMatch(options: {
  keeper: KeeperDoctorTarget;
  signerPublicKey?: string | undefined;
  rpcHealthy: boolean;
  network: StellarNetwork;
  pools: Record<string, KnownPoolMeta>;
  server: KeeperDoctorRpcServer;
  simulate: typeof simulateView;
  secretKey?: string | undefined;
}): Promise<KeeperDoctorCheck> {
  if (options.keeper === "accrual") {
    return {
      id: "vault_admin_match",
      status: "pass",
      summary:
        "Accrual keeper is permissionless; vault admin match is not required",
    };
  }

  if (!options.signerPublicKey || !options.rpcHealthy) {
    return {
      id: "vault_admin_match",
      status: "blocked",
      summary:
        "Cannot verify vault admin match until signer derivation and RPC reachability pass",
      remediation:
        "Resolve signer_derivation and rpc_reachability failures first, then re-run doctor.",
    };
  }

  const vaults = Object.values(options.pools).filter(
    (meta) => meta.protocol === "meridian" && meta.contractId
  );
  if (vaults.length === 0) {
    return {
      id: "vault_admin_match",
      status: "fail",
      summary: `No Meridian vaults are configured for ${options.network.network}`,
      remediation:
        "Verify KNOWN_POOLS includes at least one Meridian vault contractId for the target network.",
    };
  }

  const mismatched: Array<{
    vaultId: string;
    onChainAdmin: string;
    signerPublicKey: string;
  }> = [];
  const readErrors: Array<{ vaultId: string; error: string }> = [];

  for (const vault of vaults) {
    const vaultContractId = vault.contractId as string;
    try {
      const admin = expectString(
        await options.simulate(
          options.server as never,
          vaultContractId,
          options.network.passphrase,
          "get_admin"
        ),
        "get_admin",
        vaultContractId
      );
      if (admin !== options.signerPublicKey) {
        mismatched.push({
          vaultId: vault.id,
          onChainAdmin: admin,
          signerPublicKey: options.signerPublicKey,
        });
      }
    } catch (err) {
      readErrors.push({
        vaultId: vault.id,
        error: scrubSecret(redactedErrorMessage(err), options.secretKey),
      });
    }
  }

  if (readErrors.length > 0) {
    return {
      id: "vault_admin_match",
      status: "fail",
      summary: `Failed to read on-chain admin for ${readErrors.length} vault(s)`,
      remediation:
        "Verify vault contract addresses and Soroban RPC connectivity, then re-run doctor.",
      details: { readErrors },
    };
  }

  if (mismatched.length > 0) {
    return {
      id: "vault_admin_match",
      status: "fail",
      summary: `Signer public key does not match on-chain admin for ${mismatched.length} vault(s)`,
      remediation:
        "Configure MERIDIAN_MIGRATION_KEEPER_SECRET_KEY for the vault admin account, or transfer vault admin authority to this signer.",
      details: { mismatched },
    };
  }

  return {
    id: "vault_admin_match",
    status: "pass",
    summary: `Signer matches on-chain admin for all ${vaults.length} configured vault(s)`,
    details: { checkedVaults: vaults.length },
  };
}

async function checkStateStoreAccess(options: {
  keeper: KeeperDoctorTarget;
  network: StellarNetwork;
  env: Record<string, string | undefined>;
  stateStore?: KeeperStateStore | undefined;
  logger: KeeperLogger;
  secretKey?: string | undefined;
}): Promise<KeeperDoctorCheck> {
  let store: KeeperStateStore;
  try {
    store =
      options.stateStore ??
      loadKeeperStateStore(options.env, {
        keeper: options.keeper,
        requireShared: options.keeper === "migration",
        logger: options.logger,
      });
  } catch (err) {
    return {
      id: "state_store_access",
      status: "fail",
      summary: "Keeper state store is not configured",
      remediation:
        "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or Upstash KV equivalents) for cross-invocation deduplication.",
      details: {
        error: scrubSecret(redactedErrorMessage(err), options.secretKey),
      },
    };
  }

  const probeKey = submissionStateKey(
    options.keeper,
    options.network.network,
    "__doctor_probe__"
  );
  try {
    await store.get(probeKey);
    return {
      id: "state_store_access",
      status: "pass",
      summary: "Keeper state store is accessible",
    };
  } catch (err) {
    return {
      id: "state_store_access",
      status: "fail",
      summary: "Keeper state store read probe failed",
      remediation:
        "Verify UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and network access to the state store.",
      details: {
        error: scrubSecret(redactedErrorMessage(err), options.secretKey),
      },
    };
  }
}

async function checkFeeBalance(options: {
  signerPublicKey?: string | undefined;
  minFeeBalanceXlm: number;
  loadFeeBalanceXlm: (publicKey: string) => Promise<number | null>;
  secretKey?: string | undefined;
}): Promise<KeeperDoctorCheck> {
  if (!options.signerPublicKey) {
    return {
      id: "fee_balance",
      status: "blocked",
      summary: "Cannot check signer fee balance until signer derivation passes",
      remediation: "Resolve signer_derivation first, then re-run doctor.",
    };
  }

  try {
    const balanceXlm = await options.loadFeeBalanceXlm(options.signerPublicKey);
    if (balanceXlm === null) {
      return {
        id: "fee_balance",
        status: "fail",
        summary: "Signer account does not exist on-chain",
        remediation: `Fund signer account ${options.signerPublicKey} with at least ${options.minFeeBalanceXlm} XLM before running the keeper.`,
        details: {
          publicKey: options.signerPublicKey,
          minFeeBalanceXlm: options.minFeeBalanceXlm,
        },
      };
    }

    if (!Number.isFinite(balanceXlm) || balanceXlm < options.minFeeBalanceXlm) {
      return {
        id: "fee_balance",
        status: "fail",
        summary: `Signer XLM balance (${balanceXlm}) is below minimum threshold (${options.minFeeBalanceXlm} XLM)`,
        remediation: `Top up signer account ${options.signerPublicKey} with additional XLM to cover Soroban transaction fees.`,
        details: {
          publicKey: options.signerPublicKey,
          balanceXlm,
          minFeeBalanceXlm: options.minFeeBalanceXlm,
        },
      };
    }

    return {
      id: "fee_balance",
      status: "pass",
      summary: `Signer XLM balance (${balanceXlm} XLM) meets minimum threshold (${options.minFeeBalanceXlm} XLM)`,
      details: {
        publicKey: options.signerPublicKey,
        balanceXlm,
        minFeeBalanceXlm: options.minFeeBalanceXlm,
      },
    };
  } catch (err) {
    return {
      id: "fee_balance",
      status: "fail",
      summary: "Failed to check signer XLM fee balance",
      remediation:
        "Verify Horizon connectivity for the target network and retry.",
      details: {
        publicKey: options.signerPublicKey,
        error: scrubSecret(redactedErrorMessage(err), options.secretKey),
      },
    };
  }
}

function checkStrategyConfiguration(options: {
  keeper: KeeperDoctorTarget;
  env: Record<string, string | undefined>;
  strategyConfig?: KeeperDoctorStrategyConfig | undefined;
  secretKey?: string | undefined;
}): KeeperDoctorCheck {
  const issues: string[] = [];

  try {
    const maxAttempts =
      options.strategyConfig?.maxAttempts ??
      parsePositiveInt(
        options.env.MERIDIAN_KEEPER_MAX_ATTEMPTS,
        3,
        "MERIDIAN_KEEPER_MAX_ATTEMPTS"
      );
    const baseDelayMs =
      options.strategyConfig?.baseDelayMs ??
      parsePositiveInt(
        options.env.MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS,
        1_000,
        "MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS"
      );
    const rpcTimeoutMs =
      options.strategyConfig?.rpcTimeoutMs ??
      parsePositiveInt(
        options.env.MERIDIAN_KEEPER_RPC_TIMEOUT_MS,
        DEFAULT_DOCTOR_RPC_TIMEOUT_MS,
        "MERIDIAN_KEEPER_RPC_TIMEOUT_MS"
      );
    const submissionTtlMs =
      options.strategyConfig?.submissionTtlMs ??
      parseSubmissionTtlMs(options.env);

    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      issues.push("maxAttempts must be a positive integer");
    }
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) {
      issues.push("baseDelayMs must be a positive integer");
    }
    if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs < 1) {
      issues.push("rpcTimeoutMs must be a positive integer");
    }
    if (
      !Number.isInteger(submissionTtlMs) ||
      submissionTtlMs < TX_VALIDITY_WINDOW_MS
    ) {
      issues.push(`submissionTtlMs must be at least ${TX_VALIDITY_WINDOW_MS}`);
    }

    if (options.keeper === "migration") {
      const maxSlippageBps =
        options.strategyConfig?.maxSlippageBps ??
        parseNonNegativeInt(
          options.env.MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS,
          MIGRATION_DEFAULT_SLIPPAGE_BPS,
          "MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS"
        );
      if (
        !Number.isInteger(maxSlippageBps) ||
        maxSlippageBps < 0 ||
        maxSlippageBps > MAX_ADMIN_SLIPPAGE_BPS
      ) {
        issues.push(
          `maxSlippageBps must be between 0 and ${MAX_ADMIN_SLIPPAGE_BPS}`
        );
      }

      const minImprovementBps =
        options.strategyConfig?.minImprovementBps ??
        parseNonNegativeInt(
          options.env.MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS,
          50,
          "MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS"
        );
      if (!Number.isInteger(minImprovementBps) || minImprovementBps < 0) {
        issues.push("minImprovementBps must be a non-negative integer");
      }

      let candidateAdapters = options.strategyConfig?.candidateAdapters;
      if (!candidateAdapters) {
        candidateAdapters = {};
        const seenByProtocol: Record<string, string> = {};
        for (const [key, value] of Object.entries(options.env)) {
          const match = CANDIDATE_ADAPTER_ENV_PATTERN.exec(key);
          const protocol = match?.[1];
          const trimmed = value?.trim();
          if (!protocol || !trimmed) continue;
          const lower = protocol.toLowerCase();
          if (seenByProtocol[lower] && seenByProtocol[lower] !== key) {
            issues.push(
              `duplicate candidate adapter env vars for protocol "${lower}"`
            );
            continue;
          }
          seenByProtocol[lower] = key;
          candidateAdapters[lower] = trimmed;
        }
      }

      const entries = Object.entries(candidateAdapters);
      if (entries.length === 0) {
        issues.push(
          "no candidate adapters configured (set at least one MERIDIAN_ADAPTER_<PROTOCOL>_ID)"
        );
      } else {
        for (const [protocol, adapterId] of entries) {
          if (!isValidContractId(adapterId)) {
            issues.push(
              `candidate adapter for protocol "${protocol}" is not a valid Stellar contract ID`
            );
          }
        }
      }

      if (issues.length === 0) {
        return {
          id: "strategy_configuration",
          status: "pass",
          summary: "Migration strategy configuration is valid",
          details: {
            candidateAdapterCount: entries.length,
            minImprovementBps,
            maxSlippageBps,
            submissionTtlMs,
          },
        };
      }
    } else if (issues.length === 0) {
      return {
        id: "strategy_configuration",
        status: "pass",
        summary: "Accrual keeper configuration is valid",
        details: {
          maxAttempts,
          baseDelayMs,
          rpcTimeoutMs,
          submissionTtlMs,
        },
      };
    }
  } catch (err) {
    issues.push(scrubSecret(redactedErrorMessage(err), options.secretKey));
  }

  return {
    id: "strategy_configuration",
    status: "fail",
    summary: `Invalid strategy configuration: ${issues.join("; ")}`,
    remediation:
      options.keeper === "migration"
        ? "Review MERIDIAN_ADAPTER_<PROTOCOL>_ID, MERIDIAN_MIGRATION_MAX_SLIPPAGE_BPS, MERIDIAN_MIGRATION_MIN_IMPROVEMENT_BPS, and MERIDIAN_KEEPER_SUBMISSION_TTL_MS."
        : "Review MERIDIAN_KEEPER_MAX_ATTEMPTS, MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS, MERIDIAN_KEEPER_RPC_TIMEOUT_MS, and MERIDIAN_KEEPER_SUBMISSION_TTL_MS.",
    details: { issues },
  };
}

/**
 * Runs all preflight checks for a Meridian keeper and returns a structured
 * report with pass/fail/blocked statuses and remediation hints.
 *
 * Never logs or returns secret material.
 */
export async function runKeeperDoctor(
  options: KeeperDoctorOptions = {}
): Promise<KeeperDoctorReport> {
  const keeper: KeeperDoctorTarget = options.keeper ?? "migration";
  const env = options.env ?? process.env;
  const network = options.network ?? APP_NETWORK;
  const logger = options.logger ?? consoleLogger;
  const checkedAt = new Date().toISOString();

  const rawSecretKey =
    options.secretKey ??
    (keeper === "migration"
      ? env.MERIDIAN_MIGRATION_KEEPER_SECRET_KEY
      : env.MERIDIAN_KEEPER_SECRET_KEY);

  const rpcTimeoutMs =
    options.rpcTimeoutMs ??
    options.strategyConfig?.rpcTimeoutMs ??
    DEFAULT_DOCTOR_RPC_TIMEOUT_MS;
  const server: KeeperDoctorRpcServer =
    options.server ?? getRpcServer(network.rpcUrl, rpcTimeoutMs);
  const simulate = options.simulate ?? simulateView;
  const networkKey = network.network === "mainnet" ? "mainnet" : "testnet";
  const pools = options.pools ?? KNOWN_POOLS[networkKey];
  const minFeeBalanceXlm = parseMinFeeBalanceXlm(env, options.minFeeBalanceXlm);
  const loadFeeBalanceXlm =
    options.loadFeeBalanceXlm ??
    defaultLoadFeeBalanceXlm(network, rpcTimeoutMs);

  const signerResult = checkSignerDerivation(keeper, rawSecretKey);
  const rpcCheck = await checkRpcReachability(
    server,
    network,
    rpcTimeoutMs,
    rawSecretKey
  );

  const [vaultAdminCheck, stateStoreCheck, feeBalanceCheck] = await Promise.all(
    [
      checkVaultAdminMatch({
        keeper,
        signerPublicKey: signerResult.publicKey,
        rpcHealthy: rpcCheck.status === "pass",
        network,
        pools,
        server,
        simulate,
        secretKey: rawSecretKey,
      }),
      checkStateStoreAccess({
        keeper,
        network,
        env,
        stateStore: options.stateStore,
        logger,
        secretKey: rawSecretKey,
      }),
      checkFeeBalance({
        signerPublicKey: signerResult.publicKey,
        minFeeBalanceXlm,
        loadFeeBalanceXlm,
        secretKey: rawSecretKey,
      }),
    ]
  );

  const strategyCheck = checkStrategyConfiguration({
    keeper,
    env,
    strategyConfig: options.strategyConfig,
    secretKey: rawSecretKey,
  });

  const checks: KeeperDoctorCheck[] = [
    signerResult.check,
    rpcCheck,
    vaultAdminCheck,
    stateStoreCheck,
    feeBalanceCheck,
    strategyCheck,
  ];

  const hasFail = checks.some((c) => c.status === "fail");
  const hasBlocked = checks.some((c) => c.status === "blocked");
  const status: KeeperDoctorOverallStatus = hasFail
    ? "fail"
    : hasBlocked
      ? "blocked"
      : "pass";
  const ok = status === "pass";

  const blockedReasons = checks
    .filter((c) => c.status !== "pass")
    .map((c) =>
      c.remediation
        ? `${c.id}: ${c.summary} (${c.remediation})`
        : `${c.id}: ${c.summary}`
    );

  return {
    keeper,
    network: network.network,
    checkedAt,
    status,
    ok,
    ...(signerResult.publicKey && { signerPublicKey: signerResult.publicKey }),
    checks,
    blockedReasons,
  };
}
