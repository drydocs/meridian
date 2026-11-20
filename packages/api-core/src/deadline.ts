import { UpstreamDeadlineError, withRaceTimeout } from "@meridian/shared";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;

export const UPSTREAM_TIMEOUT_MS = (() => {
  const configured = Number(process.env.RPC_TIMEOUT_MS);
  return Number.isFinite(configured) &&
    configured >= 100 &&
    configured <= 30_000
    ? configured
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
})();

export function withUpstreamDeadline<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  return withRaceTimeout(fn, UPSTREAM_TIMEOUT_MS, label);
}

export function deadlineResult(error: unknown, fallback: string) {
  if (error instanceof UpstreamDeadlineError) {
    return {
      status: error.status,
      body: {
        error: "Upstream request exceeded its deadline",
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      },
      error,
    };
  }
  return { status: 500, body: { error: fallback }, error };
}
