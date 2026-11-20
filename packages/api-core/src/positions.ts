import { APP_NETWORK, isValidStellarAddress } from "@meridian/shared";
import { resolvePositions } from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";
import { deadlineResult, withUpstreamDeadline } from "./deadline";

export async function handleGetPositions(
  rawPublicKey: unknown
): Promise<RouteResult> {
  const publicKey = typeof rawPublicKey === "string" ? rawPublicKey : undefined;

  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return { status: 400, body: { error: "Invalid public key" } };
  }

  try {
    const positions = await withUpstreamDeadline(
      () => resolvePositions(publicKey, APP_NETWORK),
      "position read"
    );
    return { status: 200, body: { positions } };
  } catch (err) {
    return {
      ...deadlineResult(err, "Failed to read positions"),
    };
  }
}
