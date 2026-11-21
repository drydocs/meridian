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
/**
 * Per-wallet read+write budget. One slow wallet is cut off after this long so
 * it cannot consume the whole run.
 */
export const SNAPSHOT_PER_WALLET_TIMEOUT_MS = 10_000;
/**
 * Default per-run budget, kept safely under the 60s Vercel function cap so the
 * run can return a cursor instead of being killed mid-wallet.
 */
export const SNAPSHOT_RUN_DEADLINE_MS = 45_000;

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
 * `force` bypasses the throttle for the closing zero snapshot.
 * Also registers the user as tracked so the keeper keeps snapshotting them.
 * Never throws. Returns whether a snapshot was written.
 */
export async function recordPositionSnapshot(
  store: PositionSnapshotStore,
  publicKey: string,
  network: string,
  positions: PositionInfo[],
  logger: KeeperLogger,
  options: { now?: number; minIntervalMs?: number; force?: boolean } = {}
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const minIntervalMs = options.minIntervalMs ?? SNAPSHOT_MIN_INTERVAL_MS;
  const key = snapshotKey(publicKey, network);
  try {
    const last = await store.latest(key);
    if (!options.force && last && now - last.timestamp < minIntervalMs)
      return false;
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
  /** True when the run stopped on its deadline with wallets still unvisited. */
  hasMore: boolean;
  /**
   * Position in the tracked rotation to resume from. Pass back as `cursor` on
   * the next run. Null when the rotation was fully covered this run.
   */
  nextCursor: string | null;
  /** True when the run stopped on its time budget (deadline). */
  deadlineReached: boolean;
}

/**
 * Snapshots tracked users, oldest-seen first, honouring the same throttle as
 * the read path. The run is bounded by a total deadline and a per-wallet
 * timeout; when the deadline stops it early it returns a `nextCursor` (the
 * last publicKey it fully handled) so the next run resumes exactly there.
 * The cursor is the member key itself: it is stable under the tracked set's
 * score-based ordering as long as the wallet remains tracked.
 *
 * `resolve` returning `null` means the read was incomplete (a vault failed),
 * which is a failure and leaves the wallet tracked; an empty array means the
 * wallet holds nothing, which closes its series and drops it from rotation.
 */
export async function runPositionSnapshotKeeper(options: {
  store: PositionSnapshotStore;
  network: string;
  resolve: (publicKey: string) => Promise<PositionInfo[] | null>;
  logger: KeeperLogger;
  now?: number;
  minIntervalMs?: number;
  /** Resume after this publicKey (from a previous run's nextCursor). */
  cursor?: string | null;
  /** Absolute epoch-ms deadline for the whole run. */
  deadlineAt?: number;
  /** Hard per-wallet budget. Defaults to SNAPSHOT_PER_WALLET_TIMEOUT_MS. */
  perWalletTimeoutMs?: number;
  /** Clock source, injectable for tests. Defaults to Date.now. */
  clock?: () => number;
}): Promise<PositionSnapshotRunResult> {
  const { store, network, resolve, logger } = options;
  const clock = options.clock ?? Date.now;
  const perWalletTimeoutMs =
    options.perWalletTimeoutMs ?? SNAPSHOT_PER_WALLET_TIMEOUT_MS;
  const deadlineAt =
    options.deadlineAt ?? clock() + SNAPSHOT_RUN_DEADLINE_MS;
  const trackedKey = trackedUsersKey(network);
  const throttle = {
    ...(options.now !== undefined && { now: options.now }),
    ...(options.minIntervalMs !== undefined && {
      minIntervalMs: options.minIntervalMs,
    }),
  };

  const trackedTotal = await store.countTracked(trackedKey);
  // Fetch enough to get past the cursor and fill one batch. Members already
  // handled this rotation sort before the cursor's position, so we list from
  // the front and skip through to it. Bounded by the tracked set size.
  const listLimit = Math.min(
    trackedTotal,
    SNAPSHOT_MAX_TRACKED_PER_RUN + (options.cursor ? trackedTotal : 0)
  );
  const ordered = await store.listTracked(trackedKey, listLimit);
  let start = 0;
  if (options.cursor) {
    const idx = ordered.indexOf(options.cursor);
    // Cursor no longer tracked (untracked or rotated away): restart from the
    // oldest-seen member rather than skipping the whole rotation.
    start = idx === -1 ? 0 : idx + 1;
  }
  // Cursor wrap: if we ran off the end, wrap to the front of the rotation.
  const batch = ordered.slice(start, start + SNAPSHOT_MAX_TRACKED_PER_RUN);
  if (batch.length < SNAPSHOT_MAX_TRACKED_PER_RUN && start > 0) {
    const wrapped = ordered.slice(
      0,
      Math.min(ordered.length, SNAPSHOT_MAX_TRACKED_PER_RUN - batch.length)
    );
    batch.push(...wrapped.filter((m) => !batch.includes(m)));
  }

  const result: PositionSnapshotRunResult = {
    network,
    tracked: trackedTotal,
    processed: 0,
    recorded: 0,
    skipped: 0,
    failures: [],
    hasMore: false,
    nextCursor: null,
    deadlineReached: false,
  };

  const processWallet = async (publicKey: string): Promise<void> => {
    const positions = await resolve(publicKey);
    if (positions === null) {
      // Incomplete read: a failure, the wallet stays tracked for next run.
      result.failures.push({
        publicKey,
        error: "incomplete position read",
      });
      return;
    }
    if (positions.length === 0) {
      // Wallet no longer holds positions: write the closing zero snapshot so
      // the series shows the withdrawal, then drop it from rotation.
      await recordPositionSnapshot(store, publicKey, network, [], logger, {
        ...throttle,
        force: true,
      });
      await store.untrack(trackedKey, publicKey);
      result.recorded += 1;
      return;
    }
    const wrote = await recordPositionSnapshot(
      store,
      publicKey,
      network,
      positions,
      logger,
      throttle
    );
    if (wrote) {
      result.recorded += 1;
    } else {
      result.skipped += 1;
    }
  };

  let lastHandled: string | null = null;
  for (let i = 0; i < batch.length; i++) {
    const publicKey = batch[i]!;
    if (clock() >= deadlineAt) {
      result.deadlineReached = true;
      result.hasMore = true;
      break;
    }
    result.processed += 1;
    lastHandled = publicKey;
    try {
      await withRaceTimeout(
        processWallet(publicKey),
        perWalletTimeoutMs,
        `snapshot ${publicKey}`
      );
    } catch (err) {
      result.failures.push({ publicKey, error: errorMessage(err) });
    }
  }

  if (result.deadlineReached) {
    result.nextCursor = lastHandled;
  } else if (trackedTotal > batch.length) {
    result.hasMore = true;
    result.nextCursor = lastHandled;
  }

  if (result.failures.length > 0) {
    logger.warn("[position-snapshots] run completed with failures", {
      network,
      failures: result.failures.length,
    });
  }
  return result;
}
