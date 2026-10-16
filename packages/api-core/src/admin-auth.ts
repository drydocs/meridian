import { APP_NETWORK } from "@meridian/shared";
import {
  fetchVaultAdmin,
  type CoordinatorConfig,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

/**
 * AdminLogin is only the UI gate. Every admin API request must re-read the
 * vault's live admin so an admin rotation invalidates an existing session.
 */
export async function verifyAdmin(
  contractId: string,
  caller: string | undefined
): Promise<RouteResult | null> {
  if (!caller) {
    return { status: 401, body: { error: "Admin wallet is required" } };
  }

  try {
    const admin = await fetchVaultAdmin({
      contractId,
      network: APP_NETWORK,
    } satisfies CoordinatorConfig);
    if (caller !== admin) {
      return { status: 403, body: { error: "Admin access required" } };
    }
    return null;
  } catch (err) {
    return {
      status: 503,
      body: { error: "Failed to verify vault admin" },
      error: err,
    };
  }
}
