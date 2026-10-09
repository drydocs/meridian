import { APP_NETWORK, isValidStellarAddress } from "@meridian/shared";
import {
  consoleLogger,
  getPositionHistory,
  HISTORY_DEFAULT_DAYS,
  HISTORY_MAX_DAYS,
  loadPositionSnapshotStore,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

/**
 * Returns the stored position-value time series for one wallet, oldest first.
 * `days` defaults to 30 and is capped at the retention window; anything that
 * is not a positive integer is rejected rather than silently coerced.
 */
export async function handleGetPositionHistory(
  rawPublicKey: unknown,
  rawDays?: unknown
): Promise<RouteResult> {
  const publicKey = typeof rawPublicKey === "string" ? rawPublicKey : undefined;
  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return { status: 400, body: { error: "Invalid public key" } };
  }

  let days = HISTORY_DEFAULT_DAYS;
  if (rawDays !== undefined) {
    const parsed =
      typeof rawDays === "string" && /^\d+$/.test(rawDays)
        ? Number(rawDays)
        : NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        status: 400,
        body: { error: "days must be a positive integer" },
      };
    }
    days = Math.min(parsed, HISTORY_MAX_DAYS);
  }

  try {
    const store = loadPositionSnapshotStore(process.env, {
      logger: consoleLogger,
    });
    const snapshots = await getPositionHistory(
      store,
      publicKey,
      APP_NETWORK.network,
      days
    );
    return { status: 200, body: { publicKey, days, snapshots } };
  } catch (err) {
    return {
      status: 503,
      body: { error: "Failed to read position history" },
      error: err,
    };
  }
}
