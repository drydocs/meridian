import { APP_NETWORK, isValidStellarAddress } from "@meridian/shared";
import {
  consoleLogger,
  loadPositionSnapshotStore,
  recordPositionSnapshot,
  resolvePositions,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

export async function handleGetPositions(
  rawPublicKey: unknown
): Promise<RouteResult> {
  const publicKey = typeof rawPublicKey === "string" ? rawPublicKey : undefined;

  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return { status: 400, body: { error: "Invalid public key" } };
  }

  try {
    const positions = await resolvePositions(publicKey, APP_NETWORK);
    // Feed the history series (#973). recordPositionSnapshot never throws,
    // but building the store can, and neither may fail the live read.
    try {
      await recordPositionSnapshot(
        loadPositionSnapshotStore(process.env, { logger: consoleLogger }),
        publicKey,
        APP_NETWORK.network,
        positions,
        consoleLogger
      );
    } catch (err) {
      consoleLogger.warn("[positions] snapshot skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: 200, body: { positions } };
  } catch (err) {
    return {
      status: 503,
      body: { error: "Failed to read positions" },
      error: err,
    };
  }
}
