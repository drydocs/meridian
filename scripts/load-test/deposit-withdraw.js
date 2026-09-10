// Load test for POST /api/v1/tx/deposit and POST /api/v1/tx/withdraw
// (api/v1/tx/[action].ts -> handleDepositRequest / handleWithdrawRequest).
//
// These endpoints only BUILD an unsigned Stellar transaction (Soroban
// simulation + fee estimation) and return its XDR for a wallet to sign —
// they never move funds themselves. That makes them safe to hammer: nothing
// here submits a transaction, so nothing here can drain a real balance.
//
// Test accounts created by prepare-accounts.mjs are funded with XLM only
// (via Friendbot), not USDC. That's enough for the request to reach
// Soroban simulation and exercise the full request path (rate limiting,
// validation, RPC round trip), but the simulation itself will typically
// fail with an insufficient-balance/missing-trustline error (-> HTTP 500)
// since the account holds no USDC to deposit. This is expected and does not
// indicate a bug — see README.md "Why deposits/withdraws 500 by default".
// If you want to also exercise the 200 success path, fund a subset of the
// accounts with real testnet USDC via https://testnet.blend.capital first.
//
// Usage:
//   k6 run -e BASE_URL=https://your-preview.vercel.app scripts/load-test/deposit-withdraw.js
//
// Tunables (all optional): VUS, DEPOSIT_AMOUNT, WITHDRAW_SHARES, ACCOUNTS_FILE
//
// The default VUS is intentionally conservative (1, ~1 req/s with the
// sleep(1) below) to stay under the API's 100 req/60s per-client-IP limit
// (api/_lib/middleware.ts, LIMIT). At the previous default of 20, most
// requests were rejected as 429 before ever reaching Soroban simulation, so
// the run didn't actually exercise the 500-on-unfunded-account path this
// script (and the README section below) describes. Pass -e VUS=... to push
// past that budget on purpose.

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { SharedArray } from "k6/data";
import {
  BASE_URL,
  VAULT_ID,
  ACCOUNTS_FILE,
  jsonHeaders,
  pick,
  parseAccounts,
} from "./lib/config.js";

const accounts = new SharedArray("accounts", function () {
  return parseAccounts(open(ACCOUNTS_FILE));
});

const depositDuration = new Trend("deposit_duration_ms", true);
const withdrawDuration = new Trend("withdraw_duration_ms", true);
const rateLimited = new Rate("rate_limited_responses");
const serverErrors = new Counter("server_errors_5xx");

const VUS = Number(__ENV.VUS || 1);

export const options = {
  scenarios: {
    deposit: {
      executor: "ramping-vus",
      exec: "deposit",
      startVUs: 0,
      stages: [
        { duration: "30s", target: VUS },
        { duration: "2m", target: VUS },
        { duration: "30s", target: 0 },
      ],
    },
    withdraw: {
      executor: "ramping-vus",
      exec: "withdraw",
      startVUs: 0,
      // Runs after the deposit scenario finishes so the two don't compete
      // for the same rate-limit budget mid-ramp, which would muddy the
      // per-scenario timing numbers.
      startTime: "3m10s",
      stages: [
        { duration: "30s", target: VUS },
        { duration: "2m", target: VUS },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    // Informational default, not a hard pass/fail gate: a 500 from
    // simulation failure (see header comment) is expected with unfunded
    // accounts. Tune or remove once you know what "normal" looks like for
    // your deployment.
    http_req_duration: ["p(95)<5000"],
  },
};

export function deposit() {
  const account = pick(accounts);
  const payload = JSON.stringify({
    walletAddress: account.publicKey,
    vaultId: VAULT_ID,
    amount: __ENV.DEPOSIT_AMOUNT || "1.0000000",
    riskAcknowledged: true,
  });
  const res = http.post(`${BASE_URL}/api/v1/tx/deposit`, payload, {
    headers: jsonHeaders(),
    tags: { name: "deposit" },
  });
  depositDuration.add(res.timings.duration);
  rateLimited.add(res.status === 429);
  if (res.status >= 500) serverErrors.add(1);
  check(res, {
    "deposit: request was validated (not a 400)": (r) => r.status !== 400,
    "deposit: response is JSON": (r) => {
      try {
        r.json();
        return true;
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}

export function withdraw() {
  const account = pick(accounts);
  const payload = JSON.stringify({
    walletAddress: account.publicKey,
    vaultId: VAULT_ID,
    shares: __ENV.WITHDRAW_SHARES || "1.0000000",
  });
  const res = http.post(`${BASE_URL}/api/v1/tx/withdraw`, payload, {
    headers: jsonHeaders(),
    tags: { name: "withdraw" },
  });
  withdrawDuration.add(res.timings.duration);
  rateLimited.add(res.status === 429);
  if (res.status >= 500) serverErrors.add(1);
  check(res, {
    "withdraw: request was validated (not a 400)": (r) => r.status !== 400,
    "withdraw: response is JSON": (r) => {
      try {
        r.json();
        return true;
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
