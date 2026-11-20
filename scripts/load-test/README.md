# Load testing

The k6 suite characterizes API and keeper behavior against a disposable Stellar **testnet** deployment. Never point any load-test script or CI variable at production or mainnet.

## Scenarios

| Script | Routes | Purpose |
| --- | --- | --- |
| `deposit-withdraw.js` | `POST /api/v1/tx/deposit`, `POST /api/v1/tx/withdraw` | Unsigned transaction-build throughput |
| `positions.js` | `GET /api/v1/positions/:publicKey` | Steady-state position reads |
| `rate-limit-fallback.js` | `GET /api/v1/positions/:publicKey` | Rate-limit fallback behavior under concurrency |
| `keepers.js` | `GET /api/v1/keepers/:action` | Keeper health and submission-lease race probe |
| `endpoint-coverage.js` | `POST /api/v1/tx/add-trustline`, `POST /api/v1/tx/submit`, `GET /api/v1/vaults`, `GET /api/v1/positions/:publicKey/history`, `GET /api/v1/admin/vault-state`, `GET /api/v1/admin/history` | Missing route coverage, authenticated profile, and rate-limit profile |

The authenticated profile uses the read-only `snapshot` keeper action and a throwaway testnet `CRON_SECRET`. The submit scenario is opt-in and one-shot because it broadcasts a signed transaction; provide a fresh signed testnet XDR with `PROFILE=submit` and `SUBMIT_XDR`. Do not reuse a submitted XDR.

## Prerequisites and safety

- Install [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/).
- Use Node.js 20 or newer.
- Deploy a disposable preview with `STELLAR_NETWORK=testnet`.
- Generate throwaway test accounts: `node scripts/load-test/prepare-accounts.mjs 2`.
- Configure only throwaway testnet credentials. Never use production secrets, production URLs, or mainnet contract IDs.
- The CI workflow requires the repository variable `LOAD_TEST_BASE_URL` to point to a disposable HTTPS testnet preview. It refuses obvious production/mainnet URLs. The workflow runs manually or nightly and uploads the k6 summary as an artifact.

## Run locally

```bash
# Existing transaction builders and read scenarios
k6 run -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/deposit-withdraw.js
k6 run -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/positions.js
k6 run -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/endpoint-coverage.js

# Authenticated read-only keeper snapshot profile
k6 run -e PROFILE=authenticated -e CRON_SECRET=throwaway-testnet-secret -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/endpoint-coverage.js

# Rate-limit profile (increase traffic deliberately; 429s are expected)
k6 run -e PROFILE=rate-limit -e RATE_LIMIT_RPS=5 -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/endpoint-coverage.js

# Existing fallback characterization
k6 run -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/rate-limit-fallback.js
```

All scripts accept `ACCOUNTS_FILE` to select another account pool. `endpoint-coverage.js` supports `RPS`, `DURATION`, and `PUBLIC_KEY` overrides. Its default smoke profile uses one request per second per route and applies per-endpoint p95 latency thresholds plus a failure-rate threshold. The rate-limit profile accepts 200, 429, and 503 as observable outcomes; rate limiting is the behavior being measured.

### Submit route

`POST /api/v1/tx/submit` submits an already-signed transaction. It is excluded from routine smoke runs to avoid replaying a transaction or unexpectedly broadcasting user-supplied XDR. To exercise it, use a fresh, disposable testnet transaction exactly once:

```bash
k6 run -e PROFILE=submit -e SUBMIT_XDR="$FRESH_SIGNED_TESTNET_XDR" -e BASE_URL=https://your-disposable-testnet-preview.vercel.app scripts/load-test/endpoint-coverage.js
```

### Thresholds and interpreting results

The endpoint-coverage profile enforces p95 latency below 4 seconds for reads, 8 seconds for add-trustline transaction building, and fewer than 5% unexpected endpoint responses. Testnet RPC outages may return 503 and are accepted as transient outcomes in the route checks, but latency thresholds still apply. Tune thresholds only with a recorded baseline and a documented reason.

The rate-limit profile deliberately drives requests beyond normal traffic. A 429 is expected and counted; it is not treated as an endpoint failure. Compare the 429 counter and request rate between runs and between deployments with/without the distributed limiter.

## What this suite does not cover

- Signed submit throughput: submit is a one-shot opt-in scenario, not a sustained test, because each request broadcasts a transaction and replaying XDR is unsafe.
- Mainnet traffic, real user wallets, production credentials, or production keeper keys.
- Full-scale soak testing on every pull request. CI smoke is intentionally low volume and targets only the configured disposable testnet preview.
- Keeper actions that sign or submit transactions under real keys. The existing `keepers.js` warning and throwaway-key requirements apply; never run those actions against mainnet.

## Extending the suite

Add a dedicated exported k6 function for the route, attach a stable `endpoint` tag, record expected statuses explicitly, and add a per-endpoint latency threshold. Keep write operations idempotent or one-shot, document any required testnet fixtures, and add the route to the scenario table above. CI changes belong in `.github/workflows/load-test-smoke.yml`.
