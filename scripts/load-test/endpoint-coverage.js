// Coverage for the API routes previously missing from the k6 suite (issue #1441).
//
// All requests target a throwaway TESTNET deployment. Transaction builders
// only return unsigned XDR; this file never signs or submits a transaction.
// The optional submit scenario is deliberately one-shot and requires a fresh
// signed testnet XDR supplied explicitly via SUBMIT_XDR.
//
// Profiles:
//   PROFILE=smoke          low-volume route coverage for CI (default)
//   PROFILE=authenticated  CRON-protected, read-only keeper snapshot
//   PROFILE=rate-limit     sustained read traffic to observe 429 behavior
//
// Required: BASE_URL, ACCOUNTS_FILE. Authenticated profile also needs
// CRON_SECRET. Never point this suite at mainnet.

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";
import {
  BASE_URL,
  VAULT_ID,
  CRON_SECRET,
  ACCOUNTS_FILE,
  jsonHeaders,
  pick,
  parseAccounts,
} from "./lib/config.js";

const accounts = new SharedArray("accounts", () =>
  parseAccounts(open(ACCOUNTS_FILE))
);
const failures = new Rate("endpoint_check_failures");
const rateLimited = new Counter("endpoint_rate_limited");
const PROFILE = __ENV.PROFILE || "smoke";
const SMOKE_DURATION = __ENV.DURATION || "30s";
const PUBLIC_KEY = __ENV.PUBLIC_KEY || null;

export const options = {
  scenarios: {
    vaults: {
      executor: "constant-arrival-rate",
      exec: "vaults",
      rate: Number(__ENV.RPS || 1),
      timeUnit: "1s",
      duration: SMOKE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 5,
      tags: { profile: PROFILE, endpoint: "vaults" },
    },
    positionHistory: {
      executor: "constant-arrival-rate",
      exec: "positionHistory",
      rate: Number(__ENV.RPS || 1),
      timeUnit: "1s",
      duration: SMOKE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 5,
      tags: { profile: PROFILE, endpoint: "position-history" },
    },
    adminVaultState: {
      executor: "constant-arrival-rate",
      exec: "adminVaultState",
      rate: Number(__ENV.RPS || 1),
      timeUnit: "1s",
      duration: SMOKE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 5,
      tags: { profile: PROFILE, endpoint: "admin-vault-state" },
    },
    adminHistory: {
      executor: "constant-arrival-rate",
      exec: "adminHistory",
      rate: Number(__ENV.RPS || 1),
      timeUnit: "1s",
      duration: SMOKE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 5,
      tags: { profile: PROFILE, endpoint: "admin-history" },
    },
    addTrustline: {
      executor: "constant-arrival-rate",
      exec: "addTrustline",
      rate: Number(__ENV.RPS || 1),
      timeUnit: "1s",
      duration: SMOKE_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 5,
      tags: { profile: PROFILE, endpoint: "add-trustline" },
    },
    ...(PROFILE === "authenticated"
      ? {
          authenticatedSnapshot: {
            executor: "constant-vus",
            exec: "authenticatedSnapshot",
            vus: 1,
            duration: SMOKE_DURATION,
            tags: { profile: PROFILE, endpoint: "authenticated-snapshot" },
          },
        }
      : {}),
    ...(PROFILE === "rate-limit"
      ? {
          rateLimitProbe: {
            executor: "constant-arrival-rate",
            exec: "rateLimitProbe",
            rate: Number(__ENV.RATE_LIMIT_RPS || 5),
            timeUnit: "1s",
            duration: __ENV.RATE_LIMIT_DURATION || "90s",
            preAllocatedVUs: 10,
            maxVUs: 30,
            tags: { profile: PROFILE, endpoint: "rate-limit-probe" },
          },
        }
      : {}),
    ...(PROFILE === "submit" && __ENV.SUBMIT_XDR
      ? {
          submit: {
            executor: "shared-iterations",
            exec: "submitTransaction",
            vus: 1,
            iterations: 1,
            maxDuration: "30s",
            tags: { profile: PROFILE, endpoint: "submit" },
          },
        }
      : {}),
  },
  thresholds: {
    "http_req_duration{endpoint:vaults}": ["p(95)<4000"],
    "http_req_duration{endpoint:position-history}": ["p(95)<4000"],
    "http_req_duration{endpoint:admin-vault-state}": ["p(95)<4000"],
    "http_req_duration{endpoint:admin-history}": ["p(95)<4000"],
    "http_req_duration{endpoint:add-trustline}": ["p(95)<8000"],
    endpoint_check_failures: ["rate<0.05"],
  },
};

function record(res, name, acceptedStatuses) {
  const ok = acceptedStatuses.includes(res.status);
  failures.add(!ok);
  if (res.status === 429) rateLimited.add(1);
  check(res, {
    [`${name}: expected HTTP status`]: () => ok,
    [`${name}: response is JSON`]: (r) => {
      try {
        r.json();
        return true;
      } catch {
        return false;
      }
    },
  });
  sleep(0.2);
}

function accountKey() {
  return PUBLIC_KEY || pick(accounts).publicKey;
}

export function vaults() {
  const res = http.get(`${BASE_URL}/api/v1/vaults`, {
    tags: { endpoint: "vaults" },
  });
  record(res, "vaults", [200]);
}

export function positionHistory() {
  const res = http.get(
    `${BASE_URL}/api/v1/positions/${accountKey()}/history?days=30`,
    { tags: { endpoint: "position-history" } }
  );
  record(res, "position history", [200]);
}

export function adminVaultState() {
  const res = http.get(`${BASE_URL}/api/v1/admin/vault-state`, {
    tags: { endpoint: "admin-vault-state" },
  });
  record(res, "admin vault state", [200]);
}

export function adminHistory() {
  const res = http.get(
    `${BASE_URL}/api/v1/admin/history?vaultId=${encodeURIComponent(VAULT_ID)}`,
    { tags: { endpoint: "admin-history" } }
  );
  record(res, "admin history", [200]);
}

export function addTrustline() {
  const res = http.post(
    `${BASE_URL}/api/v1/tx/add-trustline`,
    JSON.stringify({ walletAddress: accountKey() }),
    { headers: jsonHeaders(), tags: { endpoint: "add-trustline" } }
  );
  // The generated accounts are Friendbot-funded, so the builder returns an
  // unsigned transaction. Any other status means the route is unhealthy.
  record(res, "add trustline", [200]);
}

export function authenticatedSnapshot() {
  if (!CRON_SECRET) {
    throw new Error(
      "PROFILE=authenticated requires a throwaway testnet CRON_SECRET"
    );
  }
  const res = http.get(`${BASE_URL}/api/v1/keepers/snapshot`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
    tags: { endpoint: "authenticated-snapshot" },
  });
  record(res, "authenticated keeper snapshot", [200]);
}

export function rateLimitProbe() {
  const res = http.get(`${BASE_URL}/api/v1/vaults`, {
    tags: { endpoint: "rate-limit-probe" },
  });
  const ok = [200, 429].includes(res.status);
  failures.add(!ok);
  if (res.status === 429) rateLimited.add(1);
  check(res, { "rate-limit probe: expected 200 or 429": () => ok });
}

export function submitTransaction() {
  if (!__ENV.SUBMIT_XDR) {
    throw new Error(
      "PROFILE=submit requires a fresh signed testnet SUBMIT_XDR"
    );
  }
  const res = http.post(
    `${BASE_URL}/api/v1/tx/submit`,
    JSON.stringify({ xdr: __ENV.SUBMIT_XDR }),
    { headers: jsonHeaders(), tags: { endpoint: "submit" } }
  );
  record(res, "submit transaction", [200]);
}
