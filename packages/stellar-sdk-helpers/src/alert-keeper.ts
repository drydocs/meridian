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
// State is persisted in Upstash Redis (serverless-safe: the Vercel runtime
// is per-invocation, so in-process state would be lost between runs).
// `markDelivered` uses `SET ... NX EX` and `compareAndSet` uses a Lua script.
//
// `accept_admin` is intentionally excluded from alerting even though it is
// a recognised RpcAdminActionType: it is the second half of an
// already-alerted `transfer_admin` nomination, not a new risk on its own
// (see #707's acceptance criteria, which lists paused/transfer/adapter/
// migrate only).

import { hash, rpc } from "@stellar/stellar-sdk";
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
  errorMessage,
  parsePositiveInt,
  type KeeperLogger,
} from "./keeper-retry";

export const ALERT_WEBHOOK_SIGNATURE_HEADER = "X-Meridian-Signature";
export const ALERT_WEBHOOK_TIMESTAMP_HEADER = "X-Meridian-Timestamp";
export const ALERT_WEBHOOK_DELIVERY_HEADER = "X-Meridian-Delivery";
export const DEFAULT_ALERT_WEBHOOK_TOLERANCE_SECONDS = 300;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;
/** Delivered-marker TTL: long enough to cover any realistic ledger replay. */
const DELIVERED_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Admin actions worth an immediate alert. See the file header for why
 *  `accept` is deliberately left out. */
export const ALERTABLE_ACTIONS: ReadonlySet<RpcAdminActionType> = new Set([
  "paused",
  "transfer",
  "adapter",
  "migrate",
  "mig_begin",
]);

export interface AlertKeeperConfig {
  network: StellarNetwork;
  webhookUrl: string;
  webhookSecret?: string | undefined;
  maxAttempts: number;
  baseDelayMs: number;
  rpcTimeoutMs: number;
}

export interface VerifyAlertWebhookOptions {
  toleranceSeconds?: number | undefined;
  now?: number | undefined;
}

export interface VerifyAlertWebhookResult {
  valid: boolean;
  error?: string | undefined;
}

/** Minimal Redis surface the alert keeper needs. Satisfied by the Upstash
 *  client, and by in-memory fakes in tests. */
export interface AlertStateStore {
  /** Returns the stored cursor for `key`, or null if unset. */
  getCursor(key: string): Promise<number | null>;
  /** Atomically sets `key` to `next` only if its current value equals
   *  `expected` (null meaning unset). Returns true on success. */
  compareAndSet(
    key: string,
    expected: number | null,
    next: number
  ): Promise<boolean>;
  /** Records `key` as delivered only if not already present (SET NX EX).
   *  Returns true if this call created the marker. */
  markDelivered(key: string, ttlSeconds: number): Promise<boolean>;
  /** Returns true if `key` is already marked delivered. */
  isDelivered(key: string): Promise<boolean>;
}

/** Lua script: set KEYS[1] to ARGV[2] only if its current value equals
 *  ARGV[1] (the string "nil" stands for an unset key). */
export const COMPARE_AND_SET_LUA = `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
if expected == 'nil' then
  if current then return 0 end
else
  if current ~= expected then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

function safeCompare(a: string, b: string): boolean {
  const digestA = hash(Buffer.from(a, "utf8"));
  const digestB = hash(Buffer.from(b, "utf8"));
  if (digestA.length !== digestB.length) return false;
  let mismatch = 0;
  for (let i = 0; i < digestA.length; i++) {
    mismatch |= digestA[i]! ^ digestB[i]!;
  }
  return mismatch === 0;
}

// HMAC-SHA256 built on the SDK's `hash` instead of `node:crypto`: the web app
// bundles this package, and a `node:crypto` import breaks the browser build.
// The known-answer tests pin the output to a standard HMAC, including keys
// longer than the 64 byte block size.
function computeHmacSha256Hex(secret: string, message: string): string {
  const blockSize = 64;
  let key: Buffer = Buffer.from(secret, "utf8");
  if (key.length > blockSize) {
    key = Buffer.from(hash(key));
  }
  if (key.length < blockSize) {
    key = Buffer.concat([key, Buffer.alloc(blockSize - key.length, 0)]);
  }
  const oKeyPad = Buffer.alloc(blockSize);
  const iKeyPad = Buffer.alloc(blockSize);
  for (let i = 0; i < blockSize; i++) {
    oKeyPad[i] = key[i]! ^ 0x5c;
    iKeyPad[i] = key[i]! ^ 0x36;
  }
  const msgBuf = Buffer.from(message, "utf8");
  const innerHash = hash(Buffer.concat([iKeyPad, msgBuf]));
  const outerHash = hash(Buffer.concat([oKeyPad, innerHash]));
  return outerHash.toString("hex");
}

function generateDeliveryId(): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Computes an HMAC-SHA256 signature for alert keeper webhook deliveries over
 * `${timestamp}.${deliveryId}.${body}` using the shared secret. Returns `sha256=${digest}`.
 */
export function createAlertWebhookSignature(
  timestamp: number | string,
  deliveryId: string,
  body: string,
  secret: string
): string {
  const payload = `${timestamp}.${deliveryId}.${body}`;
  const digest = computeHmacSha256Hex(secret, payload);
  return `sha256=${digest}`;
}

/**
 * Verifies an incoming webhook payload using the shared secret, enforcing HMAC-SHA256
 * signature matching and replay protection within a tolerance window (default 300 seconds).
 */
export function verifyAlertWebhookSignature(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  secret: string,
  options: VerifyAlertWebhookOptions = {}
): VerifyAlertWebhookResult {
  if (!secret) {
    return { valid: false, error: "Missing webhook secret" };
  }

  const getHeader = (name: string): string | undefined => {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) {
        return Array.isArray(value) ? value[0] : value;
      }
    }
    return undefined;
  };

  const signatureHeader = getHeader(ALERT_WEBHOOK_SIGNATURE_HEADER);
  if (!signatureHeader) {
    return {
      valid: false,
      error: `Missing ${ALERT_WEBHOOK_SIGNATURE_HEADER} header`,
    };
  }

  const timestampHeader = getHeader(ALERT_WEBHOOK_TIMESTAMP_HEADER);
  if (!timestampHeader) {
    return {
      valid: false,
      error: `Missing ${ALERT_WEBHOOK_TIMESTAMP_HEADER} header`,
    };
  }

  const deliveryHeader = getHeader(ALERT_WEBHOOK_DELIVERY_HEADER);
  if (!deliveryHeader) {
    return {
      valid: false,
      error: `Missing ${ALERT_WEBHOOK_DELIVERY_HEADER} header`,
    };
  }

  const parsedTimestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(parsedTimestamp)) {
    return {
      valid: false,
      error: `Invalid ${ALERT_WEBHOOK_TIMESTAMP_HEADER} header`,
    };
  }

  const toleranceSeconds =
    options.toleranceSeconds ?? DEFAULT_ALERT_WEBHOOK_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsedTimestamp) > toleranceSeconds) {
    return {
      valid: false,
      error: "Timestamp outside replay tolerance window",
    };
  }

  const expectedSignature = createAlertWebhookSignature(
    parsedTimestamp,
    deliveryHeader,
    body,
    secret
  );

  const normalizedSignature = signatureHeader.startsWith("sha256=")
    ? signatureHeader
    : `sha256=${signatureHeader}`;

  if (!safeCompare(normalizedSignature, expectedSignature)) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Boolean helper for verifyAlertWebhookSignature.
 */
export function isAlertWebhookSignatureValid(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  secret: string,
  options: VerifyAlertWebhookOptions = {}
): boolean {
  return verifyAlertWebhookSignature(headers, body, secret, options).valid;
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

  const webhookSecret = env.MERIDIAN_ALERT_WEBHOOK_SECRET?.trim();
  const isDeployed = Boolean(env.VERCEL_ENV || env.NODE_ENV === "production");
  if (!webhookSecret && isDeployed) {
    throw new Error(
      "MERIDIAN_ALERT_WEBHOOK_SECRET is required on deployed environments"
    );
  }

  return {
    network: APP_NETWORK,
    webhookUrl,
    webhookSecret: webhookSecret || undefined,
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
      return `[meridian] ${vaultId}: admin transfer accepted by ${shortAddr(newAdmin)} at ${at}`;
    }
    default:
      return `[meridian] ${vaultId}: ${action.action} at ${at}`;
  }
}

export interface AlertRunDeps {
  store: AlertStateStore;
  fetchAdminActions: (
    target: AlertVaultTarget,
    startLedger: number
  ) => Promise<RpcAdminAction[]>;
  sendWebhook: (message: string, deliveryId: string) => Promise<void>;
  logger?: KeeperLogger | undefined;
}

export interface AlertRunResult {
  vaultId: string;
  delivered: number;
  skipped: number;
  failed: number;
  cursorAdvancedTo: number | null;
}

/**
 * One alert run across all known vaults. For each vault:
 *  1. Read the cursor and fetch admin events from it.
 *  2. Deliver each alertable, not-yet-delivered event in ledger order,
 *     marking it delivered only after its webhook send succeeds.
 *  3. Advance the cursor (compare-and-set against the value read in step 1)
 *     only up to the last ledger before the first failed event, so failed
 *     events are retried next run.
 */
export async function runAlertKeeper(
  config: AlertKeeperConfig,
  deps: AlertRunDeps
): Promise<AlertRunResult[]> {
  const targets = discoverAlertVaultTargets(config.network);
  const results: AlertRunResult[] = [];

  for (const target of targets) {
    results.push(await processVaultAlerts(target, config, deps));
  }
  return results;
}

export async function processVaultAlerts(
  target: AlertVaultTarget,
  config: AlertKeeperConfig,
  deps: AlertRunDeps
): Promise<AlertRunResult> {
  const networkName = config.network.network;
  const cursorKey = alertCursorKey(target.vaultContractId, networkName);
  const startCursor = await deps.store.getCursor(cursorKey);
  const startLedger = startCursor ?? 0;

  const actions = await deps.fetchAdminActions(target, startLedger);
  const alertable = actions
    .filter((a) => ALERTABLE_ACTIONS.has(a.action))
    .sort((a, b) =>
      a.ledgerSequence !== b.ledgerSequence
        ? a.ledgerSequence - b.ledgerSequence
        : a.eventIndex - b.eventIndex
    );

  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  // Highest ledger we can safely move the cursor to: everything strictly
  // before the first failed event is either delivered or skipped.
  let safeLedger: number | null = null;
  let blocked = false;

  for (const action of alertable) {
    const dedupe = alertDedupeKey(
      target.vaultContractId,
      networkName,
      action
    );

    if (await deps.store.isDelivered(dedupe)) {
      skipped += 1;
      if (!blocked) safeLedger = action.ledgerSequence;
      continue;
    }

    try {
      const message = formatAlertMessage(target.vaultId, action);
      const deliveryId = generateDeliveryId();
      await withRetry(() => deps.sendWebhook(message, deliveryId), {
        maxAttempts: config.maxAttempts,
        baseDelayMs: config.baseDelayMs,
      });
      await deps.store.markDelivered(dedupe, DELIVERED_TTL_SECONDS);
      delivered += 1;
      if (!blocked) safeLedger = action.ledgerSequence;
    } catch (err) {
      failed += 1;
      blocked = true;
      deps.logger?.warn?.(
        `alert delivery failed for ${target.vaultId} ledger ${action.ledgerSequence}: ${errorMessage(err)}`
      );
    }
  }

  // Cursor advances only past ledgers fully handled, via CAS against the
  // value read at the start of this run so concurrent runs cannot regress it.
  let cursorAdvancedTo: number | null = null;
  if (safeLedger !== null && safeLedger > startLedger) {
    const ok = await deps.store.compareAndSet(
      cursorKey,
      startCursor,
      safeLedger
    );
    if (ok) {
      cursorAdvancedTo = safeLedger;
    } else {
      deps.logger?.warn?.(
        `cursor CAS lost for ${target.vaultId}; another run advanced it`
      );
    }
  }

  return {
    vaultId: target.vaultId,
    delivered,
    skipped,
    failed,
    cursorAdvancedTo,
  };
}
