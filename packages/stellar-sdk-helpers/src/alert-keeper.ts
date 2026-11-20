// Admin-event alerting keeper (#707).
//
// #698 added on-chain events for admin actions (paused, transfer, adapter,
// migrate, accept) and getRpcAdminHistory (admin-history.ts, #697) already
// knows how to read them back from Soroban RPC. Nothing consumed that feed
// for alerting until now: an unexpected pause or an adapter migration was
// only noticed by whoever happened to check the app.
//
// This keeper polls getRpcAdminHistory per known Meridian vault, starting
// from a persisted ledger cursor and posts one webhook message per
// qualifying action.
//
// Delivery guarantees:
// - Each qualifying event has a dedupe key (vault, ledger, tx hash, event
//   index). An event is recorded as delivered only after its webhook send
//   succeeds, so a replayed ledger never resends already-delivered alerts.
// - The cursor advances with compare-and-set against the value read at the
//   start of the run, so two concurrent runs cannot move it backwards.
// - A failed send leaves only that event pending; the cursor stops before
//   it so the next run retries it (and only it, plus later events).
//
// `accept_admin` is intentionally excluded from alerting even though it is
// a recognised RpcAdminActionType: it is the second half of an
// already-alerted `transfer_admin` nomination, not a new risk on its own
// (see #707's acceptance criteria, which lists paused/transfer/adapter/
// migrate only).

import { rpc } from "@stellar/stellar-sdk";
import { withRaceTimeout, withRetry } from "@meridian/shared";
import { APP_NETWORK } from "@meridian/shared";
import {
  getRpcAdminHistory,
  type RpcAdminAction,
  type RpcAdminActionType,
} from "./admin-history";
import { KNOWN_POOLS } from "./known-pools";
import type { StellarNetwork } from "./types";
import {
  consoleLogger,
  errorMessage,
  parsePositiveInt,
  type KeeperLogger,
} from "./keeper-retry";
import {
  createInMemoryKeeperHeartbeatStore,
  type KeeperHeartbeatStore,
} from "./keeper-heartbeat";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** Admin actions worth an immediate alert. See the file header for why
 *  `accept` is deliberately left out. */
const ALERTABLE_ACTIONS: ReadonlySet<RpcAdminActionType> = new Set([
  "paused",
  "transfer",
  "adapter",
  "migrate",
  "mig_begin",
]);

export interface AlertKeeperConfig {
  network: StellarNetwork;
  webhookUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  rpcTimeoutMs: number;
}

/** Mirrors isMigrationKeeperConfigured: lets ops leave the alert webhook
 *  unset early on without every cron tick throwing and reporting a 500 for
 *  an intentionally-not-yet-configured feature. */
export function isAlertKeeperConfigured(
  env: Record<string, string | undefined>
): boolean {
  return Boolean(env.MERIDIAN_ALERT_WEBHOOK_URL?.trim());
}

export function loadAlertKeeperConfig(
  env: Record<string, string | undefined>
): AlertKeeperConfig {
  const webhookUrl = env.MERIDIAN_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("MERIDIAN_ALERT_WEBHOOK_URL is required");
  }

  return {
    network: APP_NETWORK,
    webhookUrl,
    maxAttempts: parsePositiveInt(
      env.MERIDIAN_KEEPER_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      "MERIDIAN_KEEPER_MAX_ATTEMPTS"
    ),
    baseDelayMs: parsePositiveInt(
      env.MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS,
      DEFAULT_BASE_DELAY_MS,
      "MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS"
    ),
    rpcTimeoutMs: parsePositiveInt(
      env.MERIDIAN_KEEPER_RPC_TIMEOUT_MS,
      DEFAULT_RPC_TIMEOUT_MS,
      "MERIDIAN_KEEPER_RPC_TIMEOUT_MS"
    ),
  };
}

export interface AlertVaultTarget {
  vaultId: string;
  vaultContractId: string;
}

/** Every known Meridian vault on `network`, the same protocol/contractId
 *  filter accrual-keeper.ts's discovery uses. */
export function discoverAlertVaultTargets(
  network: StellarNetwork
): AlertVaultTarget[] {
  const networkKey = network.network === "mainnet" ? "mainnet" : "testnet";
  const pools = KNOWN_POOLS[networkKey];
  return Object.entries(pools)
    .filter(([, meta]) => meta.protocol === "meridian" && meta.contractId)
    .map(([vaultId, meta]) => ({
      vaultId,
      vaultContractId: meta.contractId as string,
    }));
}

/** Namespaced by network and vault so one vault's cursor can never bleed
 *  into another's, mirroring keeper-state.ts's submissionStateKey. */
export function alertCursorKey(
  vaultContractId: string,
  network: string
): string {
  return [
    "meridian",
    "keeper",
    "alert",
    "cursor",
    network,
    vaultContractId,
  ].join(":");
}

/** Namespaced dedupe key for one delivered event. Events are identified by
 *  vault, ledger, transaction hash and event index so a replayed ledger
 *  maps each event to the same key. */
export function alertDedupeKey(
  vaultContractId: string,
  network: string,
  action: RpcAdminAction
): string {
  return [
    "meridian",
    "keeper",
    "alert",
    "delivered",
    network,
    vaultContractId,
    String(action.ledgerSequence),
    action.txHash,
    String(action.eventIndex),
  ].join(":");
}

function shortAddr(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

/** Human-readable alert text for one on-chain admin action. Exported for
 *  tests; not expected to be called on an "accept" action since
 *  ALERTABLE_ACTIONS filters it out first, but handled for exhaustiveness. */
export function formatAlertMessage(
  vaultId: string,
  action: RpcAdminAction
): string {
  const at = `ledger ${action.ledgerSequence}`;
  // RpcAdminActionPayload is not discriminated by `action.action` at the
  // type level (see admin-history.ts), so each arm asserts its own shape;
  // parseAdminEvent there is what actually guarantees the pairing at
  // runtime.
  switch (action.action) {
    case "paused": {
      const { paused } = action.payload as { paused: boolean };
      return paused
        ? `[meridian] ${vaultId}: deposits PAUSED at ${at}`
        : `[meridian] ${vaultId}: deposits unpaused at ${at}`;
    }
    case "transfer": {
      const { newAdmin } = action.payload as { newAdmin: string };
      return `[meridian] ${vaultId}: admin transfer nominated to ${shortAddr(newAdmin)} at ${at}`;
    }
    case "accept": {
      const { newAdmin } = action.payload as { newAdmin: string };
      return `[meridian] ${vaultId}: admin transfer to ${shortAddr(newAdmin)} accepted at ${at}`;
    }
    case "adapter": {
      const { newAdapter } = action.payload as { newAdapter: string };
      return `[meridian] ${vaultId}: adapter switched to ${shortAddr(newAdapter)} at ${at}`;
    }
    case "migrate": {
      const { oldAdapter, newAdapter } = action.payload as {
        oldAdapter: string;
        newAdapter: string;
      };
      return `[meridian] ${vaultId}: migrated adapter from ${shortAddr(oldAdapter)} to ${shortAddr(newAdapter)} at ${at}`;
    }
    case "mig_begin": {
      const { newAdapter, earliestLedger } = action.payload as {
        newAdapter: string;
        earliestLedger: number;
      };
      return `[meridian] ${vaultId}: migration cooldown started for ${shortAddr(newAdapter)} at ${at} (earliest completion ledger ${earliestLedger})`;
    }
  }
}

/**
 * Posts one alert to `webhookUrl`. Both `text` (Slack's field) and
 * `content` (Discord's field) are sent in the same JSON body so one webhook
 * configuration works against either service without the operator having
 * to pick a payload shape up front; each service ignores the field it
 * doesn't recognise.
 */
async function sendAlert(
  webhookUrl: string,
  message: string,
  options: {
    maxAttempts: number;
    baseDelayMs: number;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  }
): Promise<void> {
  await withRetry(
    async () => {
      const response = await withRaceTimeout(
        () =>
          options.fetchImpl(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: message, content: message }),
            signal: AbortSignal.timeout(options.timeoutMs),
          }),
        options.timeoutMs,
        "alert webhook"
      );
      if (!response.ok) {
        throw new Error(
          `alert webhook request failed with HTTP ${response.status}`
        );
      }
    },
    options.maxAttempts,
    options.baseDelayMs
  );
}

export interface AlertSuccess {
  vaultId: string;
  action: RpcAdminActionType;
  ledgerSequence: number;
}

export interface AlertFailure {
  vaultId: string;
  vaultContractId: string;
  stage: "discover" | "send" | "cursor";
  attempts: number;
  error: string;
}

export interface AlertKeeperResult {
  network: StellarNetwork["network"];
  startedAt: string;
  finishedAt: string;
  vaultsChecked: number;
  alertsSent: AlertSuccess[];
  failures: AlertFailure[];
}

/**
 * Minimal store contract the alert keeper needs beyond the cursor: a
 * compare-and-set for the cursor and an idempotent "mark delivered" set for
 * dedupe. Kept separate from KeeperHeartbeatStore so the existing heartbeat
 * consumers are unaffected.
 */
export interface AlertStateStore {
  /** Atomically sets `key` to `next` only if its current value equals
   *  `expected` (`null` meaning "absent"). Returns true on success. */
  compareAndSet(
    key: string,
    expected: number | null,
    next: number
  ): Promise<boolean>;
  get(key: string): Promise<number | null>;
  /** Marks `key` as delivered. Returns true if this call newly set it. */
  markDelivered(key: string): Promise<boolean>;
  isDelivered(key: string): Promise<boolean>;
}

/** In-memory AlertStateStore. Atomic within a single process; production
 *  deployments with multiple instances should supply a shared store. */
export function createInMemoryAlertStateStore(): AlertStateStore {
  const cursors = new Map<string, number>();
  const delivered = new Set<string>();
  return {
    async compareAndSet(key, expected, next) {
      const current = cursors.has(key) ? (cursors.get(key) as number) : null;
      if (current !== expected) return false;
      cursors.set(key, next);
      return true;
    },
    async get(key) {
      return cursors.has(key) ? (cursors.get(key) as number) : null;
    },
    async markDelivered(key) {
      if (delivered.has(key)) return false;
      delivered.add(key);
      return true;
    },
    async isDelivered(key) {
      return delivered.has(key);
    },
  };
}

export interface AlertKeeperDeps {
  /** Cursor and dedupe store. Defaults to an in-memory store. */
  stateStore?: AlertStateStore;
  logger?: KeeperLogger;
  fetchImpl?: typeof fetch;
  /** Overrides vault discovery; used by tests. */
  targets?: AlertVaultTarget[];
}
