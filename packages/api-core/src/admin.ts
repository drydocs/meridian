import { APP_NETWORK } from "@meridian/shared";
import {
  consoleLogger,
  fetchCoordinatorState,
  getKeeperHeartbeat,
  isKeeperHealthy,
  KEEPER_SCHEDULE_MS,
  KNOWN_POOLS,
  loadKeeperHeartbeatStore,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";
import { deadlineResult, withUpstreamDeadline } from "./deadline";

export interface KeeperHealthEntry {
  id: "accrual" | "migration";
  intervalMs: number;
  lastSuccessMs: number | null;
  healthy: boolean;
}

/**
 * Reads both keepers' last-recorded success time (see keeper-heartbeat.ts)
 * and reports whether each is within its own schedule's overdue window.
 * Read-only and side-effect free: this never runs a keeper, only reports on
 * past runs recorded by api/v1/keepers/accrue.ts and rebalance.ts.
 */
export async function handleGetKeeperHealth(): Promise<RouteResult> {
  try {
    const store = loadKeeperHeartbeatStore(process.env, {
      logger: consoleLogger,
    });
    const now = Date.now();
    const keepers: KeeperHealthEntry[] = await Promise.all(
      (["accrual", "migration"] as const).map(async (id) => {
        const lastSuccessMs = await getKeeperHeartbeat(
          store,
          id,
          APP_NETWORK.network,
          consoleLogger
        );
        return {
          id,
          intervalMs: KEEPER_SCHEDULE_MS[id],
          lastSuccessMs,
          healthy: isKeeperHealthy(id, lastSuccessMs, now),
        };
      })
    );
    return {
      status: 200,
      body: { keepers, checkedAt: new Date(now).toISOString() },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: "Failed to read keeper health" },
      error: err,
    };
  }
}

/**
 * Reads a Meridian coordinator vault's current operational state. Without a
 * vault ID, this preserves the admin dashboard's existing default behavior.
 */
export async function handleGetVaultState(
  vaultId?: string
): Promise<RouteResult> {
  const pools =
    APP_NETWORK.network === "testnet"
      ? KNOWN_POOLS.testnet
      : KNOWN_POOLS.mainnet;
  const entries = Object.values(pools);
  const entry = entries.find(
    (p): p is typeof p & { contractId: string } =>
      p.protocol === "meridian" &&
      Boolean(p.contractId) &&
      (vaultId === undefined || p.id === vaultId)
  );
  if (!entry) {
    return {
      status: 404,
      body: {
        error: vaultId
          ? `No Meridian coordinator vault found for ${vaultId}`
          : "No Meridian coordinator vault configured for this network",
      },
    };
  }

  try {
    const state = await withUpstreamDeadline(
      () =>
        fetchCoordinatorState({
          contractId: entry.contractId,
          network: APP_NETWORK,
        }),
      "vault state"
    );
    return { status: 200, body: state };
  } catch (err) {
    return {
      ...deadlineResult(err, "Failed to read vault state", 503),
    };
  }
}
