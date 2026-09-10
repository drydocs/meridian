// Characterizes the in-memory rate-limit fallback's per-instance behavior
// under concurrent load (issue #719's primary motivation).
//
// api/_lib/middleware.ts enforces LIMIT=100 requests / 60s PER CLIENT IP.
// When UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are NOT configured
// on the deployment, it falls back to a plain in-memory Map — one per
// serverless function instance. Vercel can (and under concurrent load,
// will) spin up multiple warm instances behind the same URL, and each one
// keeps its own independent counter: nothing shares state between them. So
// the *effective* limit for a single client IP becomes roughly
// (LIMIT * number of warm instances hit), not LIMIT — exactly the
// "per-instance behavior under load" the issue calls out.
//
// This script sends sustained traffic against a read endpoint (chosen so a
// large volume of requests is safe and cheap) from a single k6 process,
// which the target sees as one client IP (or a small handful, if you're
// behind a NAT/proxy). It counts allowed vs. 429 responses so you can
// compare the observed allow-rate against the configured LIMIT=100/min.
//
// HOW TO USE THIS:
//   1. Run once against a preview deployment WITHOUT Upstash configured.
//      Expect the observed allow-rate to run well above ~100-110/min if
//      more than one instance gets warmed — that's the bug this issue
//      exists to characterize, not a failure of this script.
//   2. Run again against the same deployment WITH Upstash configured (or
//      against a deployment where it's `strict: true`-gated) to confirm the
//      distributed limiter holds the line at ~100/min regardless of how
//      many instances are behind it.
//   3. Local dev (`pnpm --filter @meridian/api-local dev`) is a single
//      process, so it CANNOT reproduce the per-instance issue — a passing
//      result there proves nothing about the deployed behavior. Always run
//      this against a real Vercel deployment.
//
// Usage:
//   k6 run -e BASE_URL=https://your-preview.vercel.app scripts/load-test/rate-limit-fallback.js
//
// Tunables (all optional): RPS, DURATION, VUS, MAX_VUS, ACCOUNTS_FILE

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { SharedArray } from "k6/data";
import { BASE_URL, ACCOUNTS_FILE, pick, parseAccounts } from "./lib/config.js";

const accounts = new SharedArray("accounts", function () {
  return parseAccounts(open(ACCOUNTS_FILE));
});

const allowed = new Counter("rate_limit_allowed");
const limited = new Counter("rate_limit_429");

export const options = {
  scenarios: {
    burst: {
      executor: "constant-arrival-rate",
      exec: "hit",
      rate: Number(__ENV.RPS || 10),
      timeUnit: "1s",
      duration: __ENV.DURATION || "90s",
      preAllocatedVUs: Number(__ENV.VUS || 50),
      maxVUs: Number(__ENV.MAX_VUS || 200),
    },
  },
};

export function hit() {
  const account = pick(accounts);
  const res = http.get(`${BASE_URL}/api/v1/positions/${account.publicKey}`, {
    tags: { name: "rate-limit-probe" },
  });
  if (res.status === 429) {
    limited.add(1);
  } else {
    allowed.add(1);
  }
  check(res, { "got a response (not a network error)": (r) => r.status !== 0 });
}

// k6's default end-of-test summary prints rate_limit_allowed and
// rate_limit_429 totals; divide `allowed` by the test's duration in minutes
// to get the observed allow-rate per minute for comparison against LIMIT=100.
