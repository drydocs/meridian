import { UpstreamDeadlineError, withRaceTimeout } from "@meridian/shared";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;

export function resolveUpstreamTimeout(value: string | undefined): number {
  const configured = Number(value);
  return Number.isFinite(configured) &&
    configured >= 100 &&
    configured <= 30_000
    ? configured
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

export const UPSTREAM_TIMEOUT_MS = resolveUpstreamTimeout(
  process.env.RPC_TIMEOUT_MS
);

export function withUpstreamDeadline<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  return withRaceTimeout(fn, UPSTREAM_TIMEOUT_MS, label);
}

export function deadlineResult(
  error: unknown,
  fallback: string,
  fallbackStatus = 500
) {
  const isDeadline =
    error instanceof UpstreamDeadlineError ||
    (error instanceof Error && error.name === "TimeoutError");

  if (isDeadline) {
    return {
      status: 503,
      body: {
        error: "Upstream request exceeded its deadline",
        code: "UPSTREAM_DEADLINE_EXCEEDED",
        retryAfterSeconds:
          error instanceof UpstreamDeadlineError ? error.retryAfterSeconds : 1,
      },
      error,
    };
  }
  return { status: fallbackStatus, body: { error: fallback }, error };
}
