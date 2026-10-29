import { APP_NETWORK, withRaceTimeout } from "@meridian/shared";
import {
  consoleLogger,
  loadPositionSnapshotStore,
  trackedUsersKey,
} from "@meridian/stellar-sdk-helpers";

const TRACK_TIMEOUT_MS = 2_000;

/**
 * Adds a wallet to the scheduled snapshot registry after a user-initiated
 * deposit or withdrawal build. The public positions read stays write-free.
 * Tracking is best effort and never prevents the transaction from being built.
 */
export async function trackPositionHistoryUser(
  publicKey: string,
  now = Date.now()
): Promise<void> {
  try {
    const store = loadPositionSnapshotStore(process.env, {
      logger: consoleLogger,
    });
    await withRaceTimeout(
      () => store.track(trackedUsersKey(APP_NETWORK.network), publicKey, now),
      TRACK_TIMEOUT_MS,
      "position snapshot tracking"
    );
  } catch (err) {
    consoleLogger.warn("[positions] snapshot tracking skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
