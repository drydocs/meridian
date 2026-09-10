// Load/race test for GET /api/v1/keepers/:action
// (api/v1/keepers/[action].ts). Covers `health` (public, read-only) and
// probes the submission-lease race on `accrue`/`rebalance`/`alert`
// (packages/stellar-sdk-helpers/src/keeper-state.ts, SubmissionLease).
//
// DANGER: accrue and rebalance sign and submit REAL Stellar transactions off
// the keeper's own funded key (MERIDIAN_KEEPER_SECRET_KEY /
// MERIDIAN_MIGRATION_KEEPER_SECRET_KEY). Only ever point this at a
// throwaway testnet deployment configured with its own throwaway keeper
// keys and its own throwaway CRON_SECRET.
//   * NEVER run this against a production/mainnet deployment.
//   * NEVER use a real project's CRON_SECRET here.
//
// This script's `concurrentInvocation` scenario is not a throughput test —
// it's a race probe. keeper-state.ts's SubmissionLease uses `SET NX` so that
// when two invocations of the same action land close together (a scheduled
// run overlapping a manual trigger, or — as here — several k6 iterations
// firing at once), only one should actually attempt the on-chain call; the
// rest should see the target already claimed and return quickly without
// broadcasting a second transaction. Concurrency is deliberately small
// (default 5) and the run is a single shared-iterations burst, not a
// sustained load, because the thing being tested is mutual exclusion, not
// capacity.
//
// Usage:
//   k6 run \
//     -e BASE_URL=https://your-preview.vercel.app \
//     -e CRON_SECRET=your-throwaway-secret \
//     scripts/load-test/keepers.js
//
// Tunables (all optional): HEALTH_RPS, DURATION, CONCURRENCY, KEEPER_ACTION
// (accrue | rebalance | alert, default accrue)
//
// health's default HEALTH_RPS is intentionally conservative (1 req/s =
// 60/min) to stay under the API's 100 req/60s per-client-IP limit
// (api/_lib/middleware.ts, LIMIT), so the "health: 200" check below passes
// out of the box. Pass -e HEALTH_RPS=... to push past that budget on
// purpose.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { BASE_URL, CRON_SECRET } from "./lib/config.js";

if (!CRON_SECRET) {
  throw new Error(
    "CRON_SECRET is required for this script (see the header comment) — " +
      "pass it with -e CRON_SECRET=... using a throwaway deployment's own secret."
  );
}

const claimedOrRan = new Counter("keeper_claimed_or_ran");
const disabledOrSkipped = new Counter("keeper_disabled_or_skipped");
const networkFailures = new Counter("keeper_network_failures");

// Parses a k6 duration string built from (\d+)(ms|h|m|s) chunks (e.g.
// "30s", "1m", "1m30s", "500ms") into whole seconds, rounded up. "ms" must
// be checked before the bare "m" alternative, otherwise "500ms" matches "m"
// first and is misread as 500 minutes. Only covers the units this script's
// DURATION tunable actually needs; not a general k6 duration parser.
function durationToSeconds(duration) {
  let seconds = 0;
  for (const [, amount, unit] of String(duration).matchAll(
    /(\d+)(ms|h|m|s)/g
  )) {
    const n = Number(amount);
    if (unit === "h") seconds += n * 3600;
    else if (unit === "m") seconds += n * 60;
    else if (unit === "ms") seconds += n / 1000;
    else seconds += n;
  }
  return Math.ceil(seconds);
}

const HEALTH_DURATION = __ENV.DURATION || "30s";
// Buffer past health's own duration so the two scenarios never overlap and
// share the strict rate-limit budget, even with an overridden DURATION.
const CONCURRENT_START_BUFFER_S = 5;
const CONCURRENT_START_S =
  durationToSeconds(HEALTH_DURATION) + CONCURRENT_START_BUFFER_S;

export const options = {
  scenarios: {
    health: {
      executor: "constant-arrival-rate",
      exec: "health",
      rate: Number(__ENV.HEALTH_RPS || 1),
      timeUnit: "1s",
      duration: HEALTH_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    concurrentInvocation: {
      executor: "shared-iterations",
      exec: "invokeConcurrently",
      vus: Number(__ENV.CONCURRENCY || 5),
      iterations: Number(__ENV.CONCURRENCY || 5),
      maxDuration: "60s",
      // Derived from health's own DURATION (plus a buffer) instead of a
      // hardcoded value, so an overridden -e DURATION=... can't make the two
      // scenarios overlap and share the strict rate-limit budget.
      startTime: `${CONCURRENT_START_S}s`,
    },
  },
};

function authHeaders() {
  return { Authorization: `Bearer ${CRON_SECRET}` };
}

export function health() {
  const res = http.get(`${BASE_URL}/api/v1/keepers/health`, {
    tags: { name: "keepers-health" },
  });
  check(res, { "health: 200": (r) => r.status === 200 });
}

export function invokeConcurrently() {
  const action = __ENV.KEEPER_ACTION || "accrue";
  const res = http.get(`${BASE_URL}/api/v1/keepers/${action}`, {
    headers: authHeaders(),
    tags: { name: `keepers-${action}` },
  });

  check(res, {
    "keeper: CRON_SECRET accepted (not 401)": (r) => r.status !== 401,
  });

  let body = null;
  try {
    body = res.json();
  } catch {
    // Either a true network failure (res.status === 0: DNS failure,
    // connection refused, timeout) or a non-JSON error page from the
    // platform rather than the app. Either way the request never reached
    // the keeper handler, so it must not fall through to "claimed or ran"
    // below: that counter is what this probe checks against on-chain
    // history, and a request that never arrived can't have raced anything.
    networkFailures.add(1);
    check(res, {
      "keeper: got a real response (not a network failure)": () => false,
    });
    return;
  }

  // Unlike alert/rebalance, accrue has no isConfigured guard in
  // api/v1/keepers/[action].ts: a missing MERIDIAN_KEEPER_SECRET_KEY makes
  // loadBlendAccrualKeeperConfig throw, which the handler's catch turns into
  // a 500 { error: ... } response — no `status` field, and no `failures`
  // field either (unlike a genuine run failure, which is still a result
  // object with `failures`). Without this check that config-error 500 would
  // silently count as "claimed or ran" even though the request never
  // reached the submission lease, so the probe would report a pass while
  // testing nothing.
  const isConfigError =
    res.status >= 500 &&
    body &&
    body.error !== undefined &&
    body.failures === undefined;

  check(res, {
    "keeper: action is configured on this deployment (not a config error)":
      () => !isConfigError,
  });

  if ((body && body.status === "disabled") || isConfigError) {
    // Either explicitly disabled (alert/rebalance's isConfigured guard), or
    // accrue's equivalent-in-effect config error above — expected on a
    // deployment that hasn't set the relevant secret up, not a race outcome.
    disabledOrSkipped.add(1);
  } else {
    claimedOrRan.add(1);
  }
}

// After the run, check your deployment's logs / on-chain history for the
// target: exactly one transaction should have been broadcast for this
// action during the concurrent burst, no matter how many of the
// `CONCURRENCY` requests landed inside the same claim window. If you see
// more than one broadcast transaction for the same tick, that's the race
// this script exists to catch.
