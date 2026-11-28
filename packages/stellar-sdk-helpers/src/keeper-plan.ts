import { getRpcServer } from "./internal";
import { simulateView } from "./tx";
import { createDefaultRateSource } from "./rate-sources";
import {
  CandidateEvaluationError,
  discoverMigrationVaults,
  findBestCandidate,
  loadMigrationPlanConfig,
  type DiscoveredVault,
  type RateSourceFn,
} from "./migration-keeper";
import {
  consoleLogger,
  redactedErrorMessage,
  sleep,
  type KeeperFailure,
  type KeeperLogger,
} from "./keeper-retry";
import { expectString, isTransientKeeperError } from "./keeper-tx";

const FUNCTION_BUDGET_MS = 50_000;

export interface MigrationPlanCandidate {
  protocol: string;
  adapterId: string;
  rateBps: number;
  improvementBps: number;
}

export interface MigrationPlanVault {
  vaultId: string;
  vaultContractId: string;
  currentAdapterId: string;
  currentProtocol: string;
  currentPoolId: string;
  currentRateBps: number | null;
  candidates: MigrationPlanCandidate[];
  bestCandidate: MigrationPlanCandidate | null;
  wouldMigrate: boolean;
  skipReason?: string;
}

export interface MigrationPlanResult {
  network: string;
  startedAt: string;
  finishedAt: string;
  configured: boolean;
  candidateAdapters: Record<string, string>;
  discoveredVaults: number;
  vaults: MigrationPlanVault[];
  skipped: { vaultId: string; reason: string }[];
  failures: KeeperFailure[];
}

export interface MigrationPlanDeps {
  discoverVaults?: () => Promise<{
    vaults: DiscoveredVault[];
    failures: KeeperFailure[];
  }>;
  rateSource?: RateSourceFn;
  resolveCandidatePool?: (adapterId: string) => Promise<string>;
  logger?: KeeperLogger;
  sleep?: (ms: number) => Promise<void>;
  deadlineAt?: number;
}

/**
 * Read-only view of the migration keeper's discovery and rate comparison.
 * Never loads MERIDIAN_MIGRATION_KEEPER_SECRET_KEY, never signs, and never
 * submits. The default rate source runs with readOnly set so a DeFindex
 * snapshot anchor is not advanced by a dry run.
 */
export async function planMigrationKeeper(
  env: Record<string, string | undefined> = process.env,
  deps: MigrationPlanDeps = {}
): Promise<MigrationPlanResult> {
  const config = loadMigrationPlanConfig(env);
  const logger = deps.logger ?? consoleLogger;
  const sleepFn = deps.sleep ?? sleep;
  const startedAt = new Date().toISOString();
  const deadlineAt = deps.deadlineAt ?? Date.now() + FUNCTION_BUDGET_MS;
  const server = getRpcServer(config.network.rpcUrl, config.rpcTimeoutMs);
  const rateSource =
    deps.rateSource ??
    createDefaultRateSource(config.network, {
      env,
      readOnly: true,
      logger,
    });
  const resolveCandidatePool =
    deps.resolveCandidatePool ??
    (async (adapterId: string) =>
      expectString(
        await simulateView(
          server as never,
          adapterId,
          config.network.passphrase,
          "get_pool"
        ),
        "get_pool",
        adapterId
      ));

  const discovery = deps.discoverVaults
    ? await deps.discoverVaults()
    : await discoverMigrationVaults({
        network: config.network,
        server,
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
        deadlineAt,
        logger,
        sleep: sleepFn,
      });

  const vaults: MigrationPlanVault[] = [];
  const skipped: { vaultId: string; reason: string }[] = [];
  const failures: KeeperFailure[] = [...discovery.failures];

  for (const vault of discovery.vaults) {
    if (Date.now() >= deadlineAt) {
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId: vault.currentAdapterId,
        protocol: vault.currentProtocol,
        stage: "evaluate",
        attempts: 0,
        transient: true,
        error:
          "Skipped: run deadline reached before this vault could be evaluated",
      });
      continue;
    }

    let evaluation;
    try {
      evaluation = await findBestCandidate(
        vault,
        config,
        rateSource,
        resolveCandidatePool,
        logger,
        sleepFn,
        deadlineAt
      );
    } catch (err) {
      const { adapterId, protocol, attempts, transient } =
        err instanceof CandidateEvaluationError
          ? err
          : {
              adapterId: vault.currentAdapterId,
              protocol: vault.currentProtocol,
              attempts: 1,
              transient: isTransientKeeperError(err),
            };
      failures.push({
        vaultId: vault.vaultId,
        vaultContractId: vault.vaultContractId,
        adapterId,
        protocol,
        stage: "evaluate",
        attempts,
        transient,
        error: redactedErrorMessage(err),
      });
      continue;
    }

    const candidates = [...evaluation.candidateRates.values()]
      .map((candidate) => ({
        protocol: candidate.protocol,
        adapterId: candidate.adapterId,
        rateBps: candidate.rate,
        improvementBps:
          evaluation.currentRate === null
            ? 0
            : candidate.rate - evaluation.currentRate,
      }))
      .sort((a, b) => b.rateBps - a.rateBps);

    const best = evaluation.best;
    vaults.push({
      vaultId: vault.vaultId,
      vaultContractId: vault.vaultContractId,
      currentAdapterId: vault.currentAdapterId,
      currentProtocol: vault.currentProtocol,
      currentPoolId: vault.currentPoolId,
      currentRateBps: evaluation.currentRate,
      candidates,
      bestCandidate: best
        ? {
            protocol: best.protocol,
            adapterId: best.adapterId,
            rateBps: evaluation.candidateRates.get(best.adapterId)?.rate ?? 0,
            improvementBps: best.improvementBps,
          }
        : null,
      wouldMigrate: best !== null,
      ...(evaluation.skipReason !== undefined && {
        skipReason: evaluation.skipReason,
      }),
    });

    if (!best) {
      skipped.push({
        vaultId: vault.vaultId,
        reason: evaluation.skipReason ?? "no migration needed",
      });
    }
  }

  return {
    network: config.network.network,
    startedAt,
    finishedAt: new Date().toISOString(),
    configured: Object.keys(config.candidateAdapters).length > 0,
    candidateAdapters: config.candidateAdapters,
    discoveredVaults: discovery.vaults.length,
    vaults,
    skipped,
    failures,
  };
}
