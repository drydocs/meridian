import type { RouteResult } from "./types";
import { getAdminActionHistory } from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";
import { deadlineResult, withUpstreamDeadline } from "./deadline";

// Meridian cannot filter onchain host function operations by contract, so every
// page is read then deduplicated and filtered until the timeout or the max
// number of pages is reached. If a vault has lots of admin history, this can
// take a while, so keep the budget within the function's timeout.
// Use thousands of operations: the budget sits under the function's
// 60s timeout on Vercel's pro plan.
const ADMIN_HISTORY_MAX_PAGES = 5;
const ADMIN_HISTORY_TIMEOUT_MS = 45_000;

export async function handleGetAdminHistory(
  vaultId: string,
  cursor?: string,
): Promise<RouteResult> {
  try {
    const pools =
      APP_NETWORK.network === "testnet"
        ? KNOWN_POOLS.testnet
        : KNOWN_POOLS.mainnet;
    const vault = pools[vaultId];
    const contractId = vault?.contractId;
    if (!contractId) {
      return {
        status: 404,
        body: { error: "vault not found or missing contractId", vaultId },
      };
    }

    const actions = await withUpstreamDeadline(
      () =>
        getAdminActionHistory(APP_NETWORK, contractId, {
          limit: 50,
          maxPages: ADMIN_HISTORY_MAX_PAGES,
          scanTimeoutMs: ADMIN_HISTORY_TIMEOUT_MS,
          cursor,
        }),
      "admin history"
    );

    return {
      status: 200,
      body: {
        vaultId,
        contractId,
        actions,
        nextCursor: (actions as any)?.nextCursor ?? null,
       updatedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      ...deadlineResult(err, "Failed to fetch admin history"),
    };
  }
}
