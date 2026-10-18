import { APP_NETWORK, isValidStellarAddress } from "@meridian/shared";
import { resolvePositions } from "@meridian/stellar-sdk-helpers";
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
    return { status: 200, body: { positions } };
  } catch (err) {
    return {
      status: 503,
      body: { error: "Failed to read positions" },
      error: err,
    };
  }
}
