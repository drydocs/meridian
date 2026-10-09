// Historical position snapshots (#973).
//
// Soroban retains no queryable historical state, so a user's position value
// over time can only be known if it is captured as it happens. This module
// is that capture: a per-user time series of snapshots (value and cumulative
// earned, per vault and protocol) stored in the same Upstash Redis the
// heartbeat and submission-lease stores already use.
//
// Storage approach: scheduled/lazy *snapshots* rather than an event indexer.
// Two writers share one throttle (`minIntervalMs`), so they never double up:
//   1. The positions read path records a snapshot (and registers the user as
//      tracked) whenever the last one is older than the throttle.
//   2. The `snapshot` keeper (api/v1/keepers/snapshot) walks the tracked set
//      on a cron and records a snapshot for each user, so history keeps
//      accruing for users who have stopped visiting the app.
// An indexer over deposit/withdraw events was rejected: it reconstructs
// cost basis but not yield accrual between events, and needs a persistent
// process and event backfill, neither of which this serverless deployment has.
//
// Like keeper-heartbeat.ts, every failure here degrades history, never the
// caller: writes and reads swallow store errors (logged) so a monitoring
// store outage can't break the live positions endpoint.

import { withRaceTimeout } from "@meridian/shared";
import { errorMessage, type KeeperLogger } from "./keeper-retry";
import { KNOWN_POOLS } from "./known-pools";
import type { PositionInfo } from "./positions";

export interface VaultSnapshot {
  vaultId: string;
  protocol: string;
  /** Current value of the holding, in asset units. */
  value: number;
  /** Cumulative yield earned on the holding, in asset units. */
  earned: number;
}

export interface PositionSnapshot {
  /** Capture time, epoch ms. */
  timestamp: number;
  totalValue: number;
  totalEarned: number;
  vaults: VaultSnapshot[];
}

/** Do not snapshot a user more often than this. */
export const SNAPSHOT_MIN_INTERVAL_MS = 30 * 60_000;
export const HISTORY_DEFAULT_DAYS = 30;
export const HISTORY_MAX_DAYS = 90;
/**
 * Snapshots retained per user: one per throttle interval across the whole
 * retention window, so the read path can serve all of `HISTORY_MAX_DAYS`
 * (4320 at a 30-minute interval). Older ones are trimmed.
 */
export const SNAPSHOT_MAX_PER_USER = Math.ceil(
  (HISTORY_MAX_DAYS * 24 * 60 * 60_000) / SNAPSHOT_MIN_INTERVAL_MS
);
/** Upper bound on users the snapshot keeper processes in one run. */
export const SNAPSHOT_MAX_TRACKED_PER_RUN = 200;

export interface PositionSnapshotStore {
  /** Appends `snapshot` and trims the series to its newest `maxEntries`. */
  append(
    key: string,
    snapshot: PositionSnapshot,
    maxEntries: number
  ): Promise<void>;
  latest(key: string): Promise<PositionSnapshot | null>;
  /** Snapshots with `timestamp >= sinceMs`, oldest first. */
  range(key: string, sinceMs: number): Promise<PositionSnapshot[]>;
  /** Registers `member`, scored by `seenAt` so the keeper can rotate fairly. */
  track(setKey: string, member: string, seenAt: number): Promise<void>;
  /** Drops `member`, for a wallet the keeper no longer needs to visit. */
  untrack(setKey: string, member: string): Promise<void>;
  /** The `limit` members seen longest ago, oldest first. */
  listTracked(setKey: string, limit: number): Promise<string[]>;
  countTracked(setKey: string): Promise<number>;
}

export function snapshotKey(publicKey: string, network: string): string {
  return ["meridian", "position-snapshots", network, publicKey].join(":");
}

export function trackedUsersKey(network: string): string {
  return ["meridian", "position-snapshots", "tracked", network].join(":");
}

function protocolForVault(vaultId: string): string {
  const pools = [
    ...Object.values(KNOWN_POOLS.mainnet),
    ...Object.values(KNOWN_POOLS.testnet),
  ];
  return pools.find((p) => p.id === vaultId)?.protocol ?? "unknown";
}

/** Pure: shapes resolved positions into a snapshot taken at `now`. */
export function buildPositionSnapshot(
  positions: PositionInfo[],
  now = Date.now()
): PositionSnapshot {
  const vaults = positions.map((p) => ({
    vaultId: p.vaultId,
    protocol: protocolForVault(p.vaultId),
    value: p.deposited,
    earned: p.earned,
  }));
  return {
    timestamp: now,
    totalValue: vaults.reduce((sum, v) => sum + v.value, 0),
    totalEarned: vaults.reduce((sum, v) => sum + v.earned, 0),
    vaults,
  };
}

function isSnapshot(value: unknown): value is PositionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === "number" &&
    typeof v.totalValue === "number" &&
    typeof v.totalEarned === "number" &&
    Array.isArray(v.vaults)
  );
}

function parseSnapshot(raw: unknown): PositionSnapshot | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Records a snapshot unless one was already taken within `minIntervalMs`.
 * Also registers the user as tracked so the keeper keeps snapshotting them.
 * Never throws. Returns whether a snapshot was written.
 */
export async function recordPositionSnapshot(
  store: PositionSnapshotStore,
  publicKey: string,
  network: string,
  positions: PositionInfo[],
  logger: KeeperLogger,
  options: { now?: number; minIntervalMs?: number } = {}
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const minIntervalMs = options.minIntervalMs ?? SNAPSHOT_MIN_INTERVAL_MS;
  const key = snapshotKey(publicKey, network);
  try {
    const last = await store.latest(key);
    if (last && now - last.timestamp < minIntervalMs) return false;
    await store.append(
      key,
      buildPositionSnapshot(positions, now),
      SNAPSHOT_MAX_PER_USER
    );
    await store.track(trackedUsersKey(network), publicKey, now);
    return true;
  } catch (err) {
    logger.warn("[position-snapshots] could not record snapshot", {
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Reads the last `days` of snapshots, oldest first. Unlike the write path
 * this throws on a store failure, so the endpoint can tell "no history yet"
 * (empty array) apart from "history unavailable" (an error).
 */
export async function getPositionHistory(
  store: PositionSnapshotStore,
  publicKey: string,
  network: string,
  days = HISTORY_DEFAULT_DAYS,
  now = Date.now()
): Promise<PositionSnapshot[]> {
  const clamped = Math.min(Math.max(days, 1), HISTORY_MAX_DAYS);
  return store.range(
    snapshotKey(publicKey, network),
    now - clamped * 24 * 60 * 60_000
  );
}

export interface PositionSnapshotRunResult {
  network: string;
  tracked: number;
  processed: number;
  recorded: number;
  skipped: number;
  failures: { publicKey: string; error: string }[];
}

/**
 * Snapshots tracked users, oldest-seen first and up to
 * SNAPSHOT_MAX_TRACKED_PER_RUN of them, honouring the same throttle as the
 * read path. `resolve` returning `null` means the read was incomplete (a
 * vault failed), which is a failure and leaves the wallet tracked; an empty
 * array means the wallet holds nothing, which closes its series and drops it
 * from the rotation.
 */
export async function runPositionSnapshotKeeper(options: {
  store: PositionSnapshotStore;
  network: string;
  resolve: (publicKey: string) => Promise<PositionInfo[] | null>;
  logger: KeeperLogger;
  now?: number;
  minIntervalMs?: number;
}): Promise<PositionSnapshotRunResult> {
  const { store, network, resolve, logger } = options;
  const trackedKey = trackedUsersKey(network);
  const throttle = {
    ...(options.now !== undefined && { now: options.now }),
    ...(options.minIntervalMs !== undefined && {
      minIntervalMs: options.minIntervalMs,
    }),
  };
  const batch = await store.listTracked(
    trackedKey,
    SNAPSHOT_MAX_TRACKED_PER_RUN
  );
  const result: PositionSnapshotRunResult = {
    network,
    tracked: await store.countTracked(trackedKey),
    processed: 0,
    recorded: 0,
    skipped: 0,
    failures: [],
  };
  for (const publicKey of batch) {
    result.processed += 1;
    try {
      const positions = await resolve(publicKey);
      if (positions === null) {
        result.failures.push({
          publicKey,
          error: "could not read every vault",
        });
        continue;
      }
      if (positions.length === 0) {
        // One final zero closes the series so the chart shows the withdrawal,
        // then the wallet leaves the rotation.
        await recordPositionSnapshot(
          store,
          publicKey,
          network,
          positions,
          logger,
          throttle
        );
        await store.untrack(trackedKey, publicKey);
        result.skipped += 1;
        continue;
      }
      const wrote = await recordPositionSnapshot(
        store,
        publicKey,
        network,
        positions,
        logger,
        throttle
      );
      if (wrote) result.recorded += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failures.push({ publicKey, error: errorMessage(err) });
    }
  }
  return result;
}

/** Per-process store, for tests and local dev. Shares nothing across invocations. */
export function createInMemoryPositionSnapshotStore(): PositionSnapshotStore {
  const series = new Map<string, PositionSnapshot[]>();
  const tracked = new Map<string, Map<string, number>>();
  return {
    async append(key, snapshot, maxEntries) {
      const list = [...(series.get(key) ?? []), snapshot].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      series.set(key, list.slice(-maxEntries));
    },
    async latest(key) {
      const list = series.get(key) ?? [];
      return list[list.length - 1] ?? null;
    },
    async range(key, sinceMs) {
      return (series.get(key) ?? []).filter((s) => s.timestamp >= sinceMs);
    },
    async track(setKey, member, seenAt) {
      const registry = tracked.get(setKey) ?? new Map<string, number>();
      registry.set(member, seenAt);
      tracked.set(setKey, registry);
    },
    async untrack(setKey, member) {
      tracked.get(setKey)?.delete(member);
    },
    async listTracked(setKey, limit) {
      return [...(tracked.get(setKey) ?? new Map<string, number>())]
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([member]) => member);
    },
    async countTracked(setKey) {
      return (tracked.get(setKey) ?? new Map<string, number>()).size;
    },
  };
}

/**
 * Upstash Redis store over the REST API (plain `fetch`, like
 * keeper-heartbeat.ts). Each user's series is a sorted set scored by capture
 * time; the tracked-user registry is a sorted set scored by last visit, so
 * the keeper always rotates onto whoever it has left longest.
 */
export function createUpstashPositionSnapshotStore(options: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): PositionSnapshotStore {
  const url = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  async function command(args: (string | number)[]): Promise<unknown> {
    const response = await withRaceTimeout(
      () =>
        fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      timeoutMs,
      "Upstash Redis"
    );
    if (!response.ok) {
      throw new Error(
        `Upstash Redis request failed with HTTP ${response.status}`
      );
    }
    const body = (await response.json()) as {
      result?: unknown;
      error?: string;
    };
    if (body.error) throw new Error(`Upstash Redis error: ${body.error}`);
    return body.result ?? null;
  }

  function parseMembers(result: unknown): PositionSnapshot[] {
    if (!Array.isArray(result)) return [];
    return result
      .map(parseSnapshot)
      .filter((s): s is PositionSnapshot => s !== null);
  }

  return {
    async append(key, snapshot, maxEntries) {
      await command([
        "ZADD",
        key,
        snapshot.timestamp,
        JSON.stringify(snapshot),
      ]);
      // Keep only the newest `maxEntries`: drop ranks 0 .. -(maxEntries + 1).
      await command(["ZREMRANGEBYRANK", key, 0, -(maxEntries + 1)]);
    },
    async latest(key) {
      return parseMembers(await command(["ZREVRANGE", key, 0, 0]))[0] ?? null;
    },
    async range(key, sinceMs) {
      return parseMembers(
        await command(["ZRANGEBYSCORE", key, sinceMs, "+inf"])
      );
    },
    async track(setKey, member, seenAt) {
      await command(["ZADD", setKey, seenAt, member]);
    },
    async untrack(setKey, member) {
      await command(["ZREM", setKey, member]);
    },
    async listTracked(setKey, limit) {
      const result = await command(["ZRANGE", setKey, 0, limit - 1]);
      return Array.isArray(result)
        ? result.filter((m): m is string => typeof m === "string")
        : [];
    },
    async countTracked(setKey) {
      const result = await command(["ZCARD", setKey]);
      return typeof result === "number" ? result : 0;
    },
  };
}

/**
 * Picks the snapshot store from the environment. Without Upstash it falls
 * back to a per-process in-memory store, which is fine locally but records
 * nothing durable on serverless, so it warns on a deployed environment.
 */
export function loadPositionSnapshotStore(
  env: Record<string, string | undefined>,
  options: {
    logger: KeeperLogger;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }
): PositionSnapshotStore {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) {
    return createUpstashPositionSnapshotStore({
      url,
      token,
      ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    });
  }
  const message =
    "[position-snapshots] no shared snapshot store configured; position history will not persist across invocations";
  if (env.VERCEL_ENV) {
    options.logger.warn(message, { store: "in-memory", env: env.VERCEL_ENV });
  } else {
    options.logger.info(message, { store: "in-memory" });
  }
  return createInMemoryPositionSnapshotStore();
}
