import type { RouteResult } from "./types";
import { getAdminActionHistory } from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";

// Horizon cannot filter invoke_host_function operations by contract, so every
// page is network-wide (200 operations) and filtered only after download.
// Keep the cold-path scan small and time-boxed so one request cannot fan out
// into thousands of operations; the budget sits under the function's
// maxDuration in vercel.json.
const ADMIN_HISTORY_MAX_PAGES = 5;
const ADMIN_HISTORY_TIMEOUT_MS = 8_000;

export async function handleGetAdminHistory(
  vaultId: string
): Promise<RouteResult> {
  try {
    const pools =
      APP_NETWORK.network === "testnet"
        ? KNOWN_POOLS.testnet
        : KNOWN_POOLS.mainnet;
    const vault = pools[vaultId];
    if (!vault?.contractId) {
      return {
        status: 404,
        body: { error: "vault not found or missing contractId", vaultId },
      };
    }

    const actions = await getAdminActionHistory(APP_NETWORK, vault.contractId, {
      limit: 50,
      maxPages: ADMIN_HISTORY_MAX_PAGES,
      scanTimeoutMs: ADMIN_HISTORY_TIMEOUT_MS,
    });

    return {
      status: 200,
      body: {
        vaultId,
        contractId: vault.contractId,
        actions,
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: "Failed to fetch admin history" },
      error: err,
    };
  }
}
