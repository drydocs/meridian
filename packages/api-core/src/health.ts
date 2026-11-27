import { createHash } from "node:crypto";
import { APP_NETWORK, withRaceTimeout } from "@meridian/shared";
import {
  checkPositionSnapshotStoreHealth,
  checkSorobanRpcHealth,
  checkUpstashRedisHealth,
  createInMemoryPositionSnapshotStore,
  createUpstashPositionSnapshotStore,
  HEALTH_CHECK_TIMEOUT_MS,
} from "@meridian/stellar-sdk-helpers";
import type { PositionSnapshotStore } from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

export const READINESS_TIMEOUT_MS = 1_900;
export const READINESS_CACHE_TTL_MS = 1_000;
export const READINESS_NEGATIVE_CACHE_TTL_MS = 500;

export type HealthDependencyStatus = "healthy" | "unhealthy";

export interface HealthBuildMetadata {
  version: string;
  commit: string | null;
  deployment: string | null;
}

interface HealthCheck<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  status: HealthDependencyStatus;
  error?: "timeout" | "unavailable" | "not_configured";
  details?: T;
}

export interface ReadinessBody {
  status: "ready" | "not_ready";
  network: string;
  version: string;
  build: HealthBuildMetadata;
  dependencies: {
    sorobanRpc: HealthCheck<{ latestLedger: number }>;
    upstashRedis: HealthCheck;
    positionSnapshots: HealthCheck<{
      mode: "persistent" | "in-memory";
      trackedUsers?: number;
    }>;
    buildMetadata: HealthCheck;
  };
  checkedAt: string;
}

interface ReadinessProbes {
  sorobanRpc(): Promise<{ latestLedger: number }>;
  upstashRedis(): Promise<void>;
  positionSnapshots(): Promise<{
    mode: "persistent" | "in-memory";
    trackedUsers: number;
  }>;
}

interface ReadinessOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  probes?: ReadinessProbes;
  /** Allows tests to exercise deadline handling without waiting 1.9 seconds. */
  readinessTimeoutMs?: number;
}

let cachedReadiness: {
  key: string;
  createdAt: number;
  body: ReadinessBody;
} | null = null;

export function clearReadinessCache(): void {
  cachedReadiness = null;
}

function getBuildMetadata(
  env: Record<string, string | undefined>
): HealthBuildMetadata {
  return {
    version:
      env.APP_VERSION?.trim() || env.npm_package_version?.trim() || "0.1.0",
    commit:
      env.VERCEL_GIT_COMMIT_SHA?.trim() || env.GIT_COMMIT_SHA?.trim() || null,
    deployment: env.VERCEL_URL?.trim() || env.DEPLOYMENT_ID?.trim() || null,
  };
}

function isDeployed(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.VERCEL_ENV?.trim() ||
    env.DEPLOYMENT_ENV?.trim() ||
    env.NODE_ENV === "production"
  );
}

function redisCredentials(env: Record<string, string | undefined>): {
  url?: string;
  token?: string;
  configured: boolean;
  partiallyConfigured: boolean;
} {
  const url = (
    env.UPSTASH_REDIS_REST_URL ?? env.UPSTASH_REDIS_REST_KV_REST_API_URL
  )?.trim();
  const token = (
    env.UPSTASH_REDIS_REST_TOKEN ?? env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN
  )?.trim();
  return {
    ...(url && { url }),
    ...(token && { token }),
    configured: Boolean(url && token),
    partiallyConfigured: Boolean(url) !== Boolean(token),
  };
}

function defaultProbes(
  env: Record<string, string | undefined>
): ReadinessProbes {
  const redis = redisCredentials(env);
  return {
    sorobanRpc: () => checkSorobanRpcHealth(APP_NETWORK.rpcUrl),
    upstashRedis: () => {
      if (!redis.configured) {
        if (!isDeployed(env) && !redis.partiallyConfigured) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("Upstash Redis is not configured"));
      }
      return checkUpstashRedisHealth({
        url: redis.url!,
        token: redis.token!,
        timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      });
    },
    positionSnapshots: async () => {
      let store: PositionSnapshotStore;
      let mode: "persistent" | "in-memory";
      if (redis.configured) {
        store = createUpstashPositionSnapshotStore({
          url: redis.url!,
          token: redis.token!,
          timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
        });
        mode = "persistent";
      } else if (!isDeployed(env) && !redis.partiallyConfigured) {
        store = createInMemoryPositionSnapshotStore();
        mode = "in-memory";
      } else {
        return Promise.reject(
          new Error("Persistent snapshot storage is not configured")
        );
      }
      const result = await checkPositionSnapshotStoreHealth(
        store,
        APP_NETWORK.network,
        HEALTH_CHECK_TIMEOUT_MS
      );
      return { ...result, mode };
    },
  };
}
function failureCode(
  err: unknown
): "timeout" | "unavailable" | "not_configured" {
  if (err instanceof Error && /not configured/i.test(err.message)) {
    return "not_configured";
  }
  if (err instanceof Error && /timed out/i.test(err.message)) return "timeout";
  return "unavailable";
}

async function runCheck<T extends Record<string, unknown>>(
  check: () => Promise<T>,
  name: string
): Promise<HealthCheck<T>> {
  try {
    const details = await withRaceTimeout(check, HEALTH_CHECK_TIMEOUT_MS, name);
    return { status: "healthy", details };
  } catch (err) {
    return { status: "unhealthy", error: failureCode(err) };
  }
}

function cacheKey(
  env: Record<string, string | undefined>,
  build: HealthBuildMetadata
): string {
  const redis = redisCredentials(env);
  return createHash("sha256")
    .update(
      JSON.stringify([
        APP_NETWORK.network,
        APP_NETWORK.rpcUrl,
        redis.url ?? "",
        redis.token ?? "",
        redis.configured,
        redis.partiallyConfigured,
        isDeployed(env),
        build.version,
        build.commit,
        build.deployment,
      ])
    )
    .digest("hex");
}

/** Liveness is deliberately synchronous and never inspects dependency clients. */
export function handleGetLiveness(): RouteResult {
  const build = getBuildMetadata(process.env);
  return {
    status: 200,
    body: {
      status: "healthy",
      network: APP_NETWORK.network,
      version: build.version,
      build,
      checkedAt: new Date().toISOString(),
    },
  };
}

/**
 * Checks all readiness dependencies concurrently. Only healthy responses are
 * cached, for at most one second, so an observed failure is never hidden by a
 * previous success and cannot be masked for a prolonged period.
 */
export async function handleGetReadiness(
  options: ReadinessOptions = {}
): Promise<RouteResult> {
  const env = options.env ?? process.env;
  const network = APP_NETWORK.network;
  const now = options.now ?? Date.now;
  const build = getBuildMetadata(env);
  const key = cacheKey(env, build);
  const startedAt = now();

  if (
    cachedReadiness?.key === key &&
    startedAt >= cachedReadiness.createdAt &&
    startedAt - cachedReadiness.createdAt <
      (cachedReadiness.body.status === "ready"
        ? READINESS_CACHE_TTL_MS
        : READINESS_NEGATIVE_CACHE_TTL_MS)
  ) {
    return {
      status: cachedReadiness.body.status === "ready" ? 200 : 503,
      body: cachedReadiness.body,
    };
  }

  const probes = options.probes ?? defaultProbes(env);
  const deployed = isDeployed(env);
  const buildHealthy =
    Boolean(build.version) && (!deployed || Boolean(build.commit));
  const readinessTimeoutMs = Math.max(
    0,
    Math.min(
      options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
      READINESS_TIMEOUT_MS
    )
  );
  type ProbesResult = Pick<
    ReadinessBody["dependencies"],
    "sorobanRpc" | "upstashRedis"
  > & {
    positionSnapshots: HealthCheck<{
      mode: "persistent" | "in-memory";
      trackedUsers?: number;
    }>;
  };
  const results: Partial<ProbesResult> = {};
  const track = <K extends keyof ProbesResult>(
    name: K,
    result: Promise<ProbesResult[K]>
  ): Promise<void> =>
    result.then((value) => {
      results[name] = value;
    });
  const checks = [
    track(
      "sorobanRpc",
      runCheck(probes.sorobanRpc, "Soroban RPC readiness check")
    ),
    track(
      "upstashRedis",
      runCheck(async () => {
        await probes.upstashRedis();
        return {};
      }, "Upstash Redis readiness check")
    ),
    track(
      "positionSnapshots",
      runCheck(probes.positionSnapshots, "Position snapshot readiness check")
    ),
  ];
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const allChecks = Promise.all(checks);
  const completedBeforeDeadline = await Promise.race([
    allChecks.then(() => true),
    new Promise<boolean>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(false), readinessTimeoutMs);
    }),
  ]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);

  const timeoutResult = { status: "unhealthy", error: "timeout" } as const;
  const snapshotResult = results.positionSnapshots;
  const dependencies: ReadinessBody["dependencies"] = {
    sorobanRpc: results.sorobanRpc ?? timeoutResult,
    upstashRedis: results.upstashRedis ?? timeoutResult,
    positionSnapshots: {
      status: snapshotResult?.status ?? "unhealthy",
      ...((snapshotResult?.error ??
        (!completedBeforeDeadline ? "timeout" : undefined)) && {
        error: snapshotResult?.error ?? "timeout",
      }),
      details: {
        mode:
          snapshotResult?.details?.mode ??
          (deployed ? "persistent" : "in-memory"),
        ...(snapshotResult?.details?.trackedUsers !== undefined && {
          trackedUsers: snapshotResult.details.trackedUsers,
        }),
      },
    },
    buildMetadata: {
      status: buildHealthy ? "healthy" : "unhealthy",
      ...(!buildHealthy && { error: "not_configured" as const }),
    },
  };
  const isHealthy = Object.values(dependencies).every(
    (dependency) => dependency.status === "healthy"
  );
  const body: ReadinessBody = {
    status: isHealthy ? "ready" : "not_ready",
    network,
    version: build.version,
    build,
    dependencies,
    checkedAt: new Date(startedAt).toISOString(),
  };
  cachedReadiness = { key, createdAt: startedAt, body };
  return { status: isHealthy ? 200 : 503, body };
}
