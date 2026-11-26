# Load testing (issue #719)

A [k6](https://k6.io) suite for characterizing how the API and keeper
endpoints behave under concurrent traffic, before mainnet. It covers:

| Script                   | Target                                                                                                                                                                                             | Purpose                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `deposit-withdraw.js`    | `POST /api/v1/tx/deposit`, `POST /api/v1/tx/withdraw`                                                                                                                                              | Throughput/latency under sustained concurrent traffic                                           |
| `positions.js`           | `GET /api/v1/positions/:publicKey`                                                                                                                                                                 | Steady-state read load                                                                          |
| `rate-limit-fallback.js` | `GET /api/v1/positions/:publicKey`                                                                                                                                                                 | Characterizes the in-memory rate-limit fallback's per-instance behavior                         |
| `keepers.js`             | `GET /api/v1/keepers/:action`                                                                                                                                                                      | `health` load, plus a concurrency probe on the accrue/rebalance/alert/snapshot submission-lease |
| `endpoint-coverage.js`   | `GET /api/v1/vaults`, `GET /api/v1/positions/:publicKey/history`, `GET /api/v1/admin/vault-state`, `GET /api/v1/admin/history`, `POST /api/v1/tx/add-trustline`, `POST /api/v1/tx/submit` (opt-in) | Route coverage with smoke, authenticated and rate-limit profiles                                |

None of these submit signed transactions except `keepers.js`'s
`accrue`/`rebalance`/`alert` invocations, which sign and submit for real off
the keeper's own key (`snapshot` reads only, signs nothing). See the safety warning below before running it.

## Prerequisites

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed locally.
- Node.js ≥ 20 (already required by the repo) for `prepare-accounts.mjs`.
- A **throwaway testnet deployment** to point these scripts at (see below).
  Never run this suite against a production/mainnet deployment.

## Setting up something to test against

**Run this against a real deployed instance, not local dev.** The
in-memory rate-limit fallback (`rate-limit-fallback.js`'s whole reason for
existing) only shows its per-instance behavior when a client's requests can
actually land on more than one warm serverless instance. `pnpm --filter
@meridian/api-local dev` is a single long-lived process, so it cannot
reproduce that bug even if the code path is broken, so a clean run there
proves nothing about production behavior.

The simplest throwaway target is a Vercel preview deployment of this
branch:

```bash
vercel deploy   # from the repo root, with the Vercel CLI linked to your fork
```

Set its environment variables (Vercel dashboard → your preview project →
Settings → Environment Variables, or `vercel env add` scoped to Preview) to
match `.env.example`:

- `STELLAR_NETWORK=testnet`
- Leave `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` **unset** for
  a run that exercises the in-memory fallback (the scenario the issue is
  about); set them to a throwaway Upstash database to test the distributed
  limiter instead, for comparison.
- `CRON_SECRET` is only needed for `keepers.js`. Set it to a throwaway value
  you generate yourself, never a real project's secret.
- `MERIDIAN_KEEPER_SECRET_KEY` is only needed to test `accrue` for real.
  Generate and fund a throwaway key (`stellar keys generate ... --fund
--network testnet`); it only needs to call the vault's permissionless
  `accrue()`, not admin authority.

You don't need to deploy your own vault contract: these scripts default to
Meridian's existing live testnet vault
(`CONTRACT_ADDRESSES.testnet.vault` in `packages/shared/src/constants.ts`).
Override `VAULT_ID` if you'd rather stand up your own throwaway vault via
`scripts/deploy-testnet.sh` (see
[`apps/docs/operations/testnet-deployment.md`](../../apps/docs/operations/testnet-deployment.md)).

## Preparing test accounts

```bash
node scripts/load-test/prepare-accounts.mjs 20
```

Generates 20 keypairs, funds each with XLM via Friendbot, and writes them to
`scripts/load-test/accounts.json` (gitignored, never commit it). The
load-test scripts only ever read `publicKey` from this file; nothing here
signs a transaction, so the `secret` field is unused by default and kept
only in case you extend the suite later.

### Why deposits/withdraws 500 by default

These accounts hold XLM only, no USDC. `POST /api/v1/tx/deposit` and
`/withdraw` build and simulate a real Soroban call
(`buildCoordinatorDepositTx`/`buildCoordinatorWithdrawTx` in
`packages/stellar-sdk-helpers/src/coordinator.ts`), and simulation fails
with an insufficient-balance or missing-trustline error for an account with
no USDC. That's still a fully exercised request: rate limiting, schema
validation, and a real Soroban RPC round trip all happen before the
failure, so it's a valid load-test data point for latency and rate-limit
behavior even though it returns HTTP 500 rather than 200.

To also exercise the 200 success path, fund a subset of the generated
accounts with testnet USDC via <https://testnet.blend.capital> (Blend's own
faucet; the default `fundFromBlendFaucet()` flow has not reliably granted
USDC in practice, see
[`testnet-deployment.md`](../../apps/docs/operations/testnet-deployment.md#getting-testnet-usdc)),
and use a `DEPOSIT_AMOUNT` within that balance.

## Running the scripts

```bash
# Deposit/withdraw throughput
k6 run -e BASE_URL=https://your-preview.vercel.app scripts/load-test/deposit-withdraw.js

# Positions read load
k6 run -e BASE_URL=https://your-preview.vercel.app scripts/load-test/positions.js

# Rate-limit fallback characterization (see the script's header comment first)
k6 run -e BASE_URL=https://your-preview.vercel.app scripts/load-test/rate-limit-fallback.js

# Keeper health + submission-lease race probe (requires CRON_SECRET)
k6 run \
  -e BASE_URL=https://your-preview.vercel.app \
  -e CRON_SECRET=your-throwaway-secret \
  scripts/load-test/keepers.js
```

All scripts accept `-e ACCOUNTS_FILE=path/to/other-accounts.json` if you
keep more than one pool. Each script's header comment documents its other
tunables (`VUS`, `RPS`, `DURATION`, etc.) and defaults.

### Endpoint coverage profiles

`endpoint-coverage.js` selects a profile with `-e PROFILE=...`:

- `smoke` (default) sends one request per second to each route and expects HTTP 200 from every one. A 404, 500 or 503 counts as a failure, so an unhealthy deployment fails the run.
- `authenticated` also calls the read-only `snapshot` keeper action with a throwaway `CRON_SECRET`.
- `rate-limit` drives sustained read traffic and accepts 200 and 429, counting the 429 responses.
- `submit` sends one signed testnet transaction from `SUBMIT_XDR` and is never part of routine runs, because it broadcasts a transaction.

It enforces p95 latency below 4 seconds for reads and 8 seconds for `add-trustline`, and fewer than 5% failed checks. Tune thresholds only with a recorded baseline and a documented reason.

## CI smoke

`.github/workflows/load-test-smoke.yml` runs the `smoke` profile on load-test pull requests, on manual dispatch and nightly. It skips entirely unless the repository variable `LOAD_TEST_BASE_URL` is set, and it refuses URLs that are not HTTPS or that look like production or mainnet. The k6 summary is uploaded as an artifact.

## Interpreting the rate-limit fallback results

`rate-limit-fallback.js` prints two counters in k6's end-of-run summary:
`rate_limit_allowed` and `rate_limit_429`. The configured limit
(`api/_lib/middleware.ts`, `LIMIT`) is 100 requests per 60 seconds per
client IP. Divide `rate_limit_allowed`'s total by the run's duration in
minutes to get the observed allow-rate:

- **≈100-110/min**: the limiter is holding the line, because either Upstash is
  configured, or the deployment stayed on a single warm instance for this
  run (try again with more concurrency/duration to warm up more instances).
- **Well above that**: multiple serverless instances are almost certainly
  each keeping their own independent in-memory counter. This is the
  per-instance behavior the issue asks to characterize, not a failure of
  the test.

## Keeper submission-lease race probe

`keepers.js`'s `concurrentInvocation` scenario fires several concurrent
requests at the same keeper action
(`packages/stellar-sdk-helpers/src/keeper-state.ts`, `SubmissionLease`).
After the run, check the deployment's function logs or the target's
on-chain history: exactly one transaction should have been broadcast for
that action during the burst, regardless of how many concurrent requests
landed inside the same claim window. More than one broadcast transaction
for the same tick is the race this probe exists to catch.

## What this suite does not cover

- `POST /api/v1/tx/submit` is only an opt-in, one-shot scenario (`PROFILE=submit`) because each request broadcasts a signed transaction and replaying XDR is unsafe. It is not a sustained throughput test. See `apps/docs/architecture/signing-flow.md` if you want to extend this.
- Mainnet traffic, real user wallets, production credentials or production keeper keys.
- Soak testing on every pull request. The CI smoke is intentionally low volume.
