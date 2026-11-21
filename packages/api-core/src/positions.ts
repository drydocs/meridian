import { createHash } from "node:crypto";
import { APP_NETWORK, isValidStellarAddress } from "@meridian/shared";
import {
  getLatestLedgerSequence,
  resolvePositions,
} from "@meridian/stellar-sdk-helpers";
import type { PositionInfo } from "@meridian/stellar-sdk-helpers";
import {
  clearPositionCacheForTesting,
  getCachedPositions,
  invalidatePositionCache,
  setCachedPositions,
} from "./position-cache";
import type { RouteResult } from "./types";
import { deadlineResult, withUpstreamDeadline } from "./deadline";

interface PositionRead {
  positions: PositionInfo[];
  etag?: string;
}

const inFlightReads = new Map<string, Promise<PositionRead>>();

export function resetPositionReadCacheForTesting(): void {
  inFlightReads.clear();
  clearPositionCacheForTesting();
}

function positionEtag(network: string, publicKey: string, ledger: number) {
  const digest = createHash("sha256")
    .update(`${network}:${publicKey}:${ledger}`)
    .digest("hex");
  return `"${digest}"`;
}

export function matchesPositionEtag(
  ifNoneMatch: string | string[] | undefined,
  etag: string | undefined
): boolean {
  if (!ifNoneMatch || !etag) return false;
  const normalizedEtag = etag.replace(/^W\//, "");
  const candidates = Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch];
  return candidates.some((header) =>
    header.split(",").some((candidate) => {
      const normalizedCandidate = candidate.trim().replace(/^W\//, "");
      return (
        normalizedCandidate === "*" || normalizedCandidate === normalizedEtag
      );
    })
  );
}

function readPositions(
  publicKey: string,
  refresh: boolean
): Promise<PositionRead> {
  const network = APP_NETWORK.network;
  const flightKey = `${network}:${publicKey}:${refresh ? "refresh" : "cached"}`;
  const existing = inFlightReads.get(flightKey);
  if (existing) return existing;

  const pending = (async () => {
    const ledger = await getLatestLedgerSequence(APP_NETWORK);
    invalidatePositionCache(network, publicKey, ledger);
    const etag = positionEtag(network, publicKey, ledger);

    if (!refresh) {
      const cached = await getCachedPositions(network, publicKey, ledger);
      if (cached) return { positions: cached, etag };
    }

    let vaultReadFailed = false;
    const positions = await resolvePositions(publicKey, APP_NETWORK, {
      onVaultError: () => {
        vaultReadFailed = true;
      },
    });
    if (vaultReadFailed) return { positions };

    await setCachedPositions(network, publicKey, ledger, positions);
    return { positions, etag };
  })();
  inFlightReads.set(flightKey, pending);
  const clearFlight = () => {
    if (inFlightReads.get(flightKey) === pending) {
      inFlightReads.delete(flightKey);
    }
  };
  void pending.then(clearFlight, clearFlight);
  return pending;
}

export async function handleGetPositions(
  rawPublicKey: unknown,
  options: { refresh?: boolean } = {}
): Promise<RouteResult> {
  const publicKey = typeof rawPublicKey === "string" ? rawPublicKey : undefined;

  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return { status: 400, body: { error: "Invalid public key" } };
  }

  try {
    const result = await withUpstreamDeadline(
      () => readPositions(publicKey, options.refresh ?? false),
      "position read"
    );
    return {
      status: 200,
      body: { positions: result.positions },
      ...(result.etag ? { etag: result.etag } : {}),
    };
  } catch (err) {
    return {
      ...deadlineResult(err, "Failed to read positions", 503),
    };
  }
}
