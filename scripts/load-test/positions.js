// Load test for GET /api/v1/positions/:publicKey
// (api/v1/positions/[publicKey].ts -> handleGetPositions -> resolvePositions).
//
// Read-only and non-strict rate limiting (see api/_lib/middleware.ts): this
// is the closest thing in the API to steady background traffic, so it's
// modeled as a constant arrival rate rather than a ramp.
//
// The default RPS is intentionally conservative (1 req/s = 60/min) to stay
// under the API's 100 req/60s per-client-IP limit (api/_lib/middleware.ts,
// LIMIT), so the "not rate limited under normal read load" check below
// passes out of the box. Pass -e RPS=... to push past that budget on
// purpose, e.g. to compare against rate-limit-fallback.js.
//
// Usage:
//   k6 run -e BASE_URL=https://your-preview.vercel.app scripts/load-test/positions.js
//
// Tunables (all optional): RPS, DURATION, VUS, MAX_VUS, ACCOUNTS_FILE

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { BASE_URL, ACCOUNTS_FILE, pick, parseAccounts } from "./lib/config.js";

const accounts = new SharedArray("accounts", function () {
  return parseAccounts(open(ACCOUNTS_FILE));
});

export const options = {
  scenarios: {
    positions: {
      executor: "constant-arrival-rate",
      exec: "readPositions",
      rate: Number(__ENV.RPS || 1),
      timeUnit: "1s",
      duration: __ENV.DURATION || "2m",
      preAllocatedVUs: Number(__ENV.VUS || 30),
      maxVUs: Number(__ENV.MAX_VUS || 100),
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<3000"],
  },
};

export function readPositions() {
  const account = pick(accounts);
  const res = http.get(`${BASE_URL}/api/v1/positions/${account.publicKey}`, {
    tags: { name: "positions" },
  });
  check(res, {
    "positions: succeeded or a known RPC hiccup (not an app error)": (r) =>
      r.status === 200 || r.status === 503,
    "positions: not rate limited under normal read load": (r) =>
      r.status !== 429,
  });
  sleep(0.5);
}
