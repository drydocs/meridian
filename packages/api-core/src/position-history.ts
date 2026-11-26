import { APP_NETWORK, isValidStellarAddress } from "@meridian/shared";
import {
  consoleLogger,
  getPositionHistory,
  HISTORY_DEFAULT_DAYS,
  HISTORY_MAX_DAYS,
  loadPositionSnapshotStore,
  type PositionSnapshot,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";
import { deadlineResult, withUpstreamDeadline } from "./deadline";

export type PositionHistoryResolution = "hour" | "day";

export const POSITION_HISTORY_DEFAULT_RESOLUTION: PositionHistoryResolution =
  "hour";
export const POSITION_HISTORY_DEFAULT_LIMIT = 720;
export const POSITION_HISTORY_MAX_LIMIT = 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface PositionHistoryBucket extends PositionSnapshot {
  min: { totalValue: number; totalEarned: number };
  max: { totalValue: number; totalEarned: number };
}

export function bucketPositionSnapshots(
  snapshots: PositionSnapshot[],
  resolution: PositionHistoryResolution
): PositionHistoryBucket[] {
  const buckets = new Map<number, PositionSnapshot[]>();

  for (const snapshot of [...snapshots].sort(
    (a, b) => a.timestamp - b.timestamp
  )) {
    const bucketTimestamp =
      resolution === "day"
        ? Math.floor(snapshot.timestamp / DAY_MS) * DAY_MS
        : Math.floor(snapshot.timestamp / HOUR_MS) * HOUR_MS;
    const bucket = buckets.get(bucketTimestamp);
    if (bucket) bucket.push(snapshot);
    else buckets.set(bucketTimestamp, [snapshot]);
  }

  return [...buckets.entries()].map(([timestamp, entries]) => {
    const last = entries[entries.length - 1]!;
    const values = entries.map((entry) => entry.totalValue);
    const earned = entries.map((entry) => entry.totalEarned);
    return {
      timestamp,
      totalValue: last.totalValue,
      totalEarned: last.totalEarned,
      vaults: last.vaults,
      min: {
        totalValue: Math.min(...values),
        totalEarned: Math.min(...earned),
      },
      max: {
        totalValue: Math.max(...values),
        totalEarned: Math.max(...earned),
      },
    };
  });
}

/**
 * Returns the stored position-value time series for one wallet, oldest first.
 * `days` defaults to 30 and is capped at the retention window; anything that
 * is not a positive integer is rejected rather than silently coerced.
 */
export async function handleGetPositionHistory(
  rawPublicKey: unknown,
  rawDays?: unknown,
  rawResolution?: unknown,
  rawLimit?: unknown,
  rawCursor?: unknown
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

  if (
    rawResolution !== undefined &&
    rawResolution !== "hour" &&
    rawResolution !== "day"
  ) {
    return { status: 400, body: { error: "resolution must be hour or day" } };
  }
  const resolution: PositionHistoryResolution =
    rawResolution === "day" ? "day" : "hour";

  let limit = POSITION_HISTORY_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const parsed =
      typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
        ? Number(rawLimit)
        : NaN;
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > POSITION_HISTORY_MAX_LIMIT
    ) {
      return {
        status: 400,
        body: {
          error: `limit must be an integer between 1 and ${POSITION_HISTORY_MAX_LIMIT}`,
        },
      };
    }
    limit = parsed;
  }

  let cursorTimestamp: number | undefined;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor)) {
      return {
        status: 400,
        body: { error: "cursor must be a timestamp in milliseconds" },
      };
    }
    cursorTimestamp = Number(rawCursor);
    if (!Number.isSafeInteger(cursorTimestamp)) {
      return {
        status: 400,
        body: { error: "cursor must be a timestamp in milliseconds" },
      };
    }
  }

  try {
    const store = loadPositionSnapshotStore(process.env, {
      logger: consoleLogger,
    });
    const snapshots = await withUpstreamDeadline(
      () => getPositionHistory(store, publicKey, APP_NETWORK.network, days),
      "position history"
    );
    // A request with no pagination parameters keeps the original response: every
    // stored snapshot, oldest first. The chart asks for up to 90 days this way
    // and must not lose its newest points to a page limit.
    if (
      rawResolution === undefined &&
      rawLimit === undefined &&
      rawCursor === undefined
    ) {
      return { status: 200, body: { publicKey, days, snapshots } };
    }

    const buckets = bucketPositionSnapshots(snapshots, resolution);
    const eligible =
      cursorTimestamp === undefined
        ? buckets
        : buckets.filter((bucket) => bucket.timestamp > cursorTimestamp);
    const page = eligible.slice(0, limit);
    const truncated = eligible.length > page.length;
    const nextCursor =
      truncated && page.length > 0
        ? String(page[page.length - 1]!.timestamp)
        : null;

    return {
      status: 200,
      body: {
        publicKey,
        days,
        resolution,
        snapshots: page,
        nextCursor,
        truncated,
      },
    };
  } catch (err) {
    return {
      ...deadlineResult(err, "Failed to read position history", 503),
    };
  }
}
