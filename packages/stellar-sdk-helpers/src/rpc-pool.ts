import type { rpc } from "@stellar/stellar-sdk";
import { getRpcServer } from "./internal";
import type { StellarNetwork } from "./types";

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_READ_TIMEOUT_MS = 10_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 12_000;
export const FAILURE_WINDOW_MS = 5 * 60_000;

export interface RpcLogEntry {
  level: "info" | "warn" | "error";
  event: "rpc_probe" | "rpc_read" | "rpc_write";
  endpoint: string;
  latencyMs: number;
  ok: boolean;
  failureReason?: string;
}

export type RpcLogger = (entry: RpcLogEntry) => void;

export interface RpcEndpointHealth {
  url: string;
  healthy: boolean;
  latencyMs: number | null;
  recentFailures: number;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  score: number;
}

export interface RpcAttemptFailure {
  endpoint: string;
  latencyMs: number;
  reason: string;
}

export class RpcAllEndpointsFailedError extends Error {
  readonly attempts: RpcAttemptFailure[];

  constructor(attempts: RpcAttemptFailure[], message?: string) {
    const summary =
      message ??
      (attempts.length > 0
        ? `All Soroban RPC endpoints failed: ${attempts
            .map((a) => `${a.endpoint} (${a.reason})`)
            .join("; ")}`
        : "All Soroban RPC endpoints failed");
    super(summary);
    this.name = "RpcAllEndpointsFailedError";
    this.attempts = attempts;
  }
}

export interface RpcProbeOptions {
  timeoutMs?: number;
  logger?: RpcLogger;
}

export interface RpcReadOptions {
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
  logger?: RpcLogger;
}

export interface RpcWriteOptions {
  timeoutMs?: number;
  allowFailover?: boolean;
  perAttemptTimeoutMs?: number;
  logger?: RpcLogger;
}

export type RpcEndpointTarget = StellarNetwork | string | readonly string[];

interface InternalEndpointState {
  healthy: boolean;
  latencyMs: number | null;
  failureTimestamps: number[];
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

const _healthState = new Map<string, InternalEndpointState>();

function defaultRpcLogger(entry: RpcLogEntry): void {
  if (!entry.ok) {
    console.warn(
      `[soroban-rpc] event=${entry.event} endpoint=${entry.endpoint} latencyMs=${entry.latencyMs} error=${entry.failureReason ?? "unknown"}`
    );
  }
}

let _defaultLogger: RpcLogger = defaultRpcLogger;

/** Override the default RPC logger (pass `undefined` to restore default). */
export function setRpcLogger(logger?: RpcLogger): void {
  _defaultLogger = logger ?? defaultRpcLogger;
}

/** Clear all tracked RPC endpoint health state. Exported for test isolation. */
export function clearRpcHealthState(): void {
  _healthState.clear();
}

/**
 * Resolve an ordered, deduplicated list of RPC URLs from a `StellarNetwork`,
 * a comma-separated string, or an array of URLs. Index 0 is the primary.
 */
export function resolveRpcUrls(target: RpcEndpointTarget): string[] {
  const rawList: string[] = [];
  if (typeof target === "string") {
    rawList.push(target);
  } else if (Array.isArray(target)) {
    for (const item of target) {
      rawList.push(item);
    }
  } else {
    const net = target as StellarNetwork;
    if (net.rpcUrls && net.rpcUrls.length > 0) {
      for (const item of net.rpcUrls) {
        rawList.push(item);
      }
    } else if (net.rpcUrl) {
      rawList.push(net.rpcUrl);
    }
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of rawList) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        urls.push(trimmed);
      }
    }
  }

  if (urls.length === 0) {
    throw new Error("No Soroban RPC URLs configured");
  }
  return urls;
}

function getOrCreateState(url: string): InternalEndpointState {
  let state = _healthState.get(url);
  if (!state) {
    state = {
      healthy: true,
      latencyMs: null,
      failureTimestamps: [],
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    };
    _healthState.set(url, state);
  }
  return state;
}

function pruneFailures(state: InternalEndpointState, now: number): number {
  const cutoff = now - FAILURE_WINDOW_MS;
  if (state.failureTimestamps.length > 0) {
    state.failureTimestamps = state.failureTimestamps.filter(
      (ts) => ts >= cutoff
    );
  }
  return state.failureTimestamps.length;
}

function computeScore(
  state: InternalEndpointState,
  recentFailures: number
): number {
  if (!state.healthy) {
    return Math.max(0, 20 - state.consecutiveFailures * 5);
  }
  if (state.latencyMs === null) {
    return Math.max(21, 80 - Math.min(40, recentFailures * 10));
  }
  const failurePenalty = Math.min(40, recentFailures * 10);
  const latencyPenalty = Math.min(39, Math.floor(state.latencyMs / 100));
  return Math.max(21, 100 - failurePenalty - latencyPenalty);
}

function toSnapshot(
  url: string,
  state: InternalEndpointState,
  now: number
): RpcEndpointHealth {
  const recentFailures = pruneFailures(state, now);
  return {
    url,
    healthy: state.healthy,
    latencyMs: state.latencyMs,
    recentFailures,
    consecutiveFailures: state.consecutiveFailures,
    lastCheckedAt: state.lastCheckedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastError: state.lastError,
    score: computeScore(state, recentFailures),
  };
}

function recordSuccess(
  url: string,
  latencyMs: number,
  now: number
): RpcEndpointHealth {
  const state = getOrCreateState(url);
  state.healthy = true;
  state.latencyMs = latencyMs;
  state.consecutiveFailures = 0;
  state.lastCheckedAt = now;
  state.lastSuccessAt = now;
  state.lastError = null;
  return toSnapshot(url, state, now);
}

function recordFailure(
  url: string,
  latencyMs: number,
  reason: string,
  now: number
): RpcEndpointHealth {
  const state = getOrCreateState(url);
  state.healthy = false;
  state.latencyMs = latencyMs;
  state.consecutiveFailures += 1;
  state.failureTimestamps.push(now);
  state.lastCheckedAt = now;
  state.lastFailureAt = now;
  state.lastError = reason;
  return toSnapshot(url, state, now);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Whether an error says the endpoint itself is unhealthy: a timeout, a
 * transport failure, a rate limit or a 5xx response. Contract, simulation and
 * validation errors come from the request, not the endpoint, so trying another
 * endpoint cannot fix them and they must reach the caller unchanged.
 */
export function isEndpointFailure(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } } | null)?.response
    ?.status;
  if (typeof status === "number") return status >= 500 || status === 429;
  const message = errorMessage(err);
  return /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|too many requests|rate limit|(?:HTTP|status)[ :]*(?:429|5\d\d)\b|bad gateway|service unavailable|gateway timeout/i.test(
    message
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  endpoint: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`RPC call to ${endpoint} timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function rankEndpoints(urls: readonly string[], now: number): string[] {
  return urls
    .map((url, index) => {
      const state = _healthState.get(url);
      const snapshot = state
        ? toSnapshot(url, state, now)
        : {
            url,
            healthy: true,
            score: 80,
          };
      return { url, index, healthy: snapshot.healthy, score: snapshot.score };
    })
    .sort((a, b) => {
      if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((item) => item.url);
}

/**
 * Return current health snapshots for the given endpoints (or all tracked
 * endpoints when called with no arguments).
 */
export function getRpcEndpointHealth(
  target?: RpcEndpointTarget
): RpcEndpointHealth[] {
  const now = Date.now();
  const urls = target
    ? resolveRpcUrls(target)
    : Array.from(_healthState.keys());
  return urls.map((url) => {
    const state = _healthState.get(url);
    if (!state) {
      return {
        url,
        healthy: true,
        latencyMs: null,
        recentFailures: 0,
        consecutiveFailures: 0,
        lastCheckedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        score: 80,
      };
    }
    return toSnapshot(url, state, now);
  });
}

/**
 * Probe a single Soroban RPC endpoint using `getLatestLedger`, updating its
 * latency, failure counters, and health score.
 */
export async function probeRpcEndpoint(
  url: string,
  options: RpcProbeOptions = {}
): Promise<RpcEndpointHealth> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const logger = options.logger ?? _defaultLogger;
  const startedAt = Date.now();

  try {
    const server = getRpcServer(url, timeoutMs);
    await withTimeout(server.getLatestLedger(), timeoutMs, url);
    const now = Date.now();
    const latencyMs = Math.max(0, now - startedAt);
    const snapshot = recordSuccess(url, latencyMs, now);
    logger({
      level: "info",
      event: "rpc_probe",
      endpoint: url,
      latencyMs,
      ok: true,
    });
    return snapshot;
  } catch (err) {
    const now = Date.now();
    const latencyMs = Math.max(0, now - startedAt);
    const reason = errorMessage(err);
    const snapshot = recordFailure(url, latencyMs, reason, now);
    logger({
      level: "warn",
      event: "rpc_probe",
      endpoint: url,
      latencyMs,
      ok: false,
      failureReason: reason,
    });
    return snapshot;
  }
}

/**
 * Probe all configured Soroban RPC endpoints in parallel.
 */
export async function probeRpcEndpoints(
  target: RpcEndpointTarget,
  options: RpcProbeOptions = {}
): Promise<RpcEndpointHealth[]> {
  const urls = resolveRpcUrls(target);
  return Promise.all(urls.map((url) => probeRpcEndpoint(url, options)));
}

/**
 * Execute a read-only Soroban RPC call, failing over to the healthiest
 * endpoint within a bounded total timeout.
 */
export async function withRpcReadFailover<T>(
  target: RpcEndpointTarget,
  operation: (server: rpc.Server, url: string) => Promise<T>,
  options: RpcReadOptions = {}
): Promise<T> {
  const urls = resolveRpcUrls(target);
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const logger = options.logger ?? _defaultLogger;
  const ordered = rankEndpoints(urls, Date.now());
  const deadline = Date.now() + timeoutMs;
  const attempts: RpcAttemptFailure[] = [];

  for (const url of ordered) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      attempts.push({
        endpoint: url,
        latencyMs: 0,
        reason: `Bounded failover timeout of ${timeoutMs}ms exhausted`,
      });
      break;
    }

    const attemptTimeoutMs = Math.max(
      1,
      Math.min(remainingMs, options.perAttemptTimeoutMs ?? timeoutMs)
    );
    const startedAt = Date.now();
    try {
      const server = getRpcServer(url, attemptTimeoutMs);
      const result = await withTimeout(
        operation(server, url),
        attemptTimeoutMs,
        url
      );
      const now = Date.now();
      const latencyMs = Math.max(0, now - startedAt);
      recordSuccess(url, latencyMs, now);
      logger({
        level: "info",
        event: "rpc_read",
        endpoint: url,
        latencyMs,
        ok: true,
      });
      return result;
    } catch (err) {
      const now = Date.now();
      const latencyMs = Math.max(0, now - startedAt);
      const reason = errorMessage(err);
      if (!isEndpointFailure(err)) {
        logger({
          level: "warn",
          event: "rpc_read",
          endpoint: url,
          latencyMs,
          ok: false,
          failureReason: reason,
        });
        throw err;
      }
      recordFailure(url, latencyMs, reason, now);
      attempts.push({ endpoint: url, latencyMs, reason });
      logger({
        level: "warn",
        event: "rpc_read",
        endpoint: url,
        latencyMs,
        ok: false,
        failureReason: reason,
      });
    }
  }

  throw new RpcAllEndpointsFailedError(attempts);
}

/**
 * Execute a write Soroban RPC call. By default, writes stay pinned to the
 * primary endpoint (`urls[0]`) and never silently switch endpoints. Pass
 * `allowFailover: true` to explicitly opt into failover.
 */
export async function withRpcWrite<T>(
  target: RpcEndpointTarget,
  operation: (server: rpc.Server, url: string) => Promise<T>,
  options: RpcWriteOptions = {}
): Promise<T> {
  const urls = resolveRpcUrls(target);
  const [primary, ...rest] = urls;
  if (!primary) {
    throw new Error("No Soroban RPC URLs configured");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const logger = options.logger ?? _defaultLogger;
  const allowFailover = options.allowFailover ?? false;

  if (!allowFailover) {
    const startedAt = Date.now();
    try {
      const server = getRpcServer(primary, timeoutMs);
      const result = await withTimeout(
        operation(server, primary),
        timeoutMs,
        primary
      );
      const now = Date.now();
      const latencyMs = Math.max(0, now - startedAt);
      recordSuccess(primary, latencyMs, now);
      logger({
        level: "info",
        event: "rpc_write",
        endpoint: primary,
        latencyMs,
        ok: true,
      });
      return result;
    } catch (err) {
      const now = Date.now();
      const latencyMs = Math.max(0, now - startedAt);
      const reason = errorMessage(err);
      if (isEndpointFailure(err))
        recordFailure(primary, latencyMs, reason, now);
      logger({
        level: "error",
        event: "rpc_write",
        endpoint: primary,
        latencyMs,
        ok: false,
        failureReason: reason,
      });
      throw err;
    }
  }

  // Explicit opt-in failover: try primary first, then remaining by health.
  const ordered = [primary, ...rankEndpoints(rest, Date.now())];
  const deadline = Date.now() + timeoutMs;
  const attempts: RpcAttemptFailure[] = [];

  for (const url of ordered) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      attempts.push({
        endpoint: url,
        latencyMs: 0,
        reason: `Bounded failover timeout of ${timeoutMs}ms exhausted`,
      });
      break;
    }

    const attemptTimeoutMs = Math.max(
      1,
      Math.min(remainingMs, options.perAttemptTimeoutMs ?? timeoutMs)
    );
    const startedAt = Date.now();
    try {
      const server = getRpcServer(url, attemptTimeoutMs);
      const result = await withTimeout(
        operation(server, url),
        attemptTimeoutMs,
        url
      );
      const now = Date.now();
      const latencyMs = Math.max(0, now - startedAt);
      recordSuccess(url, latencyMs, now);
      logger({
        level: "info",
        event: "rpc_write",
        endpoint: url,
        latencyMs,
        ok: true,
      });
      return result;
    } catch (err) {
      const now = Date.now();
      const latencyMs = Math.max(0, now - startedAt);
      const reason = errorMessage(err);
      if (!isEndpointFailure(err)) {
        logger({
          level: "error",
          event: "rpc_write",
          endpoint: url,
          latencyMs,
          ok: false,
          failureReason: reason,
        });
        throw err;
      }
      recordFailure(url, latencyMs, reason, now);
      attempts.push({ endpoint: url, latencyMs, reason });
      logger({
        level: "error",
        event: "rpc_write",
        endpoint: url,
        latencyMs,
        ok: false,
        failureReason: reason,
      });
    }
  }

  throw new RpcAllEndpointsFailedError(attempts);
}
