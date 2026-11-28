# Outage recovery runbook

This runbook covers outages of the external services Meridian depends on:
Upstash Redis, Soroban RPC, DeFiLlama, Vercel, and GitHub Actions. It defines
recovery objectives (RPO/RTO), degraded-mode behavior, tested backup/restore
and failover procedures, depositor communications, and tabletop scenarios.

**Scope boundary:** This page is for _infrastructure and third-party dependency
outages_. For live security or operational incidents on the vault itself
(pausing deposits, rotating the admin key, rotating keeper secrets), see
[Incident Response](./incident-response.md). For deploying fixed contract code,
see [Mainnet Deployment](./mainnet-deployment.md#rollback-plan).

## Dependency impact matrix

| Dependency         | What uses it                                                                                                                                                                  | Impact when down                                                                                                                                                                                                                                                                     | On-chain funds at risk? |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| **Upstash Redis**  | Distributed rate limiting (`api/_lib/middleware.ts`), keeper leases (`keeper-state.ts`), alert cursors (`alert-keeper.md`), heartbeats, vault/rate caches, position snapshots | Strict routes (fund-moving/keeper endpoints) return `503 RATE_LIMIT_BACKEND_UNAVAILABLE`. Migration keeper refuses to run. Accrual keeper loses cross-invocation dedup. Position history falls back to per-process memory and stops persisting. Alert keeper cannot advance cursors. | No                      |
| **Soroban RPC**    | All contract reads/simulations/submissions (`packages/stellar-sdk-helpers`), all keepers, API vault/position reads                                                            | Vault deposits/withdrawals via the app fail to simulate or submit. Keepers fail RPC lookups and cannot submit `accrue()`, `migrate_adapter`, or scan admin events.                                                                                                                   | No                      |
| **DeFiLlama**      | Mainnet APY/TVL discovery and protocol yield rankings (`packages/stellar-sdk-helpers/src/rate-sources.ts`)                                                                    | Mainnet vault reads serve stale data from Vercel edge cache (`stale-while-revalidate=300`) briefly, then degrade. Migration keeper cannot evaluate candidate APYs and skips rebalancing.                                                                                             | No                      |
| **Vercel**         | Hosts web app (`apps/web`), serverless API (`api/v1/`), and keeper HTTP endpoints                                                                                             | Web UI and API are unreachable. Scheduled GitHub Actions keeper calls fail with 5xx/timeouts. Depositors cannot use the web UI but can still withdraw directly on-chain.                                                                                                             | No                      |
| **GitHub Actions** | Runs `.github/workflows/keepers.yml` (alert every 5m, accrual every 15m, migration & snapshots hourly)                                                                        | Automated keepers stop firing. Blend interest accrual, yield rebalancing, hourly position snapshots, and admin-event webhook alerts pause until manually triggered or restored.                                                                                                      | No                      |

## Recovery objectives (RPO and RTO)

On-chain vault state (balances, shares, adapter pointer, pause flag) lives on
the Stellar ledger and has **RPO = 0** independent of Meridian's off-chain
infrastructure. The targets below apply to Meridian's off-chain services and
operational state:

| Dependency         | RPO (data loss tolerance)                                                                                 | RTO (service restoration target)        | Recovery mechanism                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Upstash Redis**  | 24h for position snapshots; 0 for leases (reconstructed on-chain); 0 for alert cursors (audited on-chain) | 30 minutes                              | Restore snapshot backup into a new Upstash database and update Vercel env vars.               |
| **Soroban RPC**    | 0 (stateless)                                                                                             | 30 minutes                              | Switch `STELLAR_NETWORKS.<network>.rpcUrl` to a healthy provider and redeploy.                |
| **DeFiLlama**      | 0 (stateless external feed)                                                                               | Dependent on upstream (mitigate in 15m) | Serve cached values; pause migration keeper if stale data causes noise; wait for upstream.    |
| **Vercel**         | 0 (stateless deployment from Git)                                                                         | 60 minutes (or upstream recovery)       | Monitor Vercel status; trigger manual keeper runs locally if extended; redeploy once healthy. |
| **GitHub Actions** | 0 (stateless scheduler)                                                                                   | 30 minutes                              | Trigger keeper HTTP endpoints manually via `curl` with `CRON_SECRET` until Actions recovers.  |

## Upstash Redis: export, restore, and scratch verification

Upstash stores six categories of keys:

1. **Keeper submission leases:** `meridian:keeper:<accrual|migration>:<network>:<target>` (TTL: 60s claim / 360s submission).
2. **Alert keeper cursors:** `meridian:keeper:alert:cursor:<network>:<vaultContractId>` (integer ledger number, no TTL).
3. **Keeper heartbeats:** `meridian:keeper:heartbeat:<keeper>:<network>` (timestamp).
4. **Position snapshots & tracked wallets:** 90-day history (up to 2,160 snapshots per wallet).
5. **Vault and rate caches:** short-lived caches (safe to drop on restore).
6. **Rate-limit sliding windows:** `@upstash/ratelimit` keys (ephemeral; do not restore).

### Export procedure

Run a daily scheduled export (or an ad-hoc export before maintenance) using the
Upstash REST API or `redis-cli --tls`. Using `redis-cli` with the database's
TLS endpoint from the Upstash Console:

```sh
# Export all persistent Meridian keys (excluding ephemeral rate-limit windows)
redis-cli --tls -u "$UPSTASH_REDIS_TLS_URL" --scan --pattern "meridian:*" \
  > meridian-keys.txt

# Dump key metadata (type, TTL in ms, and serialized value) into a JSONL backup
while IFS= read -r key; do
  type=$(redis-cli --tls -u "$UPSTASH_REDIS_TLS_URL" TYPE "$key")
  pttl=$(redis-cli --tls -u "$UPSTASH_REDIS_TLS_URL" PTTL "$key")
  dump=$(redis-cli --tls -u "$UPSTASH_REDIS_TLS_URL" --raw DUMP "$key" | base64 -w0)
  printf '{"key":"%s","type":"%s","pttl":%s,"dump":"%s"}\n' "$key" "$type" "$pttl" "$dump"
done < meridian-keys.txt > meridian-backup-$(date -u +%Y%m%dT%H%M%SZ).jsonl
```

Store the resulting `.jsonl` file in encrypted object storage (not in Git).

### Restore procedure (into a scratch or failover Upstash database)

1. Provision a new Upstash Redis database in the Upstash Console (same region
   as the Vercel deployment).
2. Restore the backup into the target database, skipping expired keys and
   ephemeral rate-limit/lease keys:

   ```sh
   # Restore persistent keys (cursors, heartbeats, position snapshots) into scratch/failover DB
   while IFS= read -r line; do
     key=$(printf '%s' "$line" | jq -r '.key')
     pttl=$(printf '%s' "$line" | jq -r '.pttl')
     dump=$(printf '%s' "$line" | jq -r '.dump')

     # Skip submission leases: they are short-lived (<= 360s) and must be
     # reconstructed from on-chain state rather than replayed from a backup.
     case "$key" in
       meridian:keeper:accrual:*|meridian:keeper:migration:*) continue ;;
     esac

     ttl_arg=0
     if [ "$pttl" -gt 0 ]; then
       ttl_arg="$pttl"
     fi

     # `redis-cli -x` appends stdin as the final argument, so `RESTORE` must end
     # with the serialized payload (not `REPLACE`). Delete any existing key first
     # to get overwrite semantics.
     redis-cli --tls -u "$SCRATCH_UPSTASH_TLS_URL" DEL "$key" >/dev/null
     printf '%s' "$dump" | base64 -d \
       | redis-cli --tls -u "$SCRATCH_UPSTASH_TLS_URL" -x RESTORE "$key" "$ttl_arg"
   done < meridian-backup.jsonl
   ```

3. Verify the restored scratch database before cutting over traffic:

   ```sh
   # Confirm key counts and sample values
   redis-cli --tls -u "$SCRATCH_UPSTASH_TLS_URL" --scan --pattern "meridian:*" | wc -l
   redis-cli --tls -u "$SCRATCH_UPSTASH_TLS_URL" GET "meridian:keeper:alert:cursor:mainnet:CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ"
   ```

4. Cut over production by updating `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` in Vercel (**Project Settings > Environment
   Variables**) and triggering a redeploy.

### Scratch restore drill checklist

Run this drill against a scratch Upstash database quarterly and after any
change to Redis key schemas, using the exact export and restore commands above:

1. **Seed synthetic keys** in a source scratch database:
   - Alert cursor (`meridian:keeper:alert:cursor:testnet:...`)
   - Heartbeat (`meridian:keeper:heartbeat:accrual:testnet`)
   - A sample position snapshot key with a TTL
   - An active migration lease (`meridian:keeper:migration:testnet:meridian-usdc`)
2. **Run the export and restore scripts** above against a second scratch
   Upstash database.
3. **Verify results:**
   - Persistent keys (cursor, heartbeat, position snapshot) restore cleanly via
     `DEL` + `redis-cli -x RESTORE "$key" "$ttl_arg"` with exact values and
     preserved TTLs.
   - Submission lease keys are excluded by the restore filter so stale locks
     are never re-introduced.
   - Rate-limit keys are excluded and regenerate cleanly on first API request.
   - Pointing a local API instance (`UPSTASH_REDIS_REST_URL` /
     `UPSTASH_REDIS_REST_TOKEN`) at the restored scratch database passes
     rate-limit and keeper-state checks with no errors.

## Keeper lease and cursor recovery

### Submission leases (`keeper-state.ts`)

Both the accrual and migration keepers acquire a two-step lease in Upstash
before building and signing a transaction (`packages/stellar-sdk-helpers/src/keeper-state.ts`):

- **Claim phase:** `SET NX` with `hash: null` and a 60s TTL (`DEFAULT_CLAIM_TTL_MS`).
- **Signed phase:** compare-and-set (`EVAL`) with the signed transaction hash
  and a 360s TTL (`DEFAULT_SUBMISSION_TTL_MS` = 300s tx validity + 60s skew).

When Upstash is unreachable:

- `resolvePriorSubmission` returns `{ state: "unknown" }`.
- The **migration keeper** refuses to run (`requireShared: true` on deployed
  environments) so it can never submit a duplicate `migrate_adapter` and pay
  slippage twice.
- The **accrual keeper** logs a warning and degrades to per-process memory if
  Upstash env vars are unset, or skips targets if the store call errors.

**Recovery steps for a stuck or lost lease:**

1. **Wait for natural expiry first.** Every lease has a Redis-side `PX` expiry
   (at most 60s for an unsigned claim, 360s for a signed tx). Once the
   transaction's 300s validity window passes, the transaction can never land.
2. **If you must inspect before expiry,** read the lease key:

   ```sh
   redis-cli --tls -u "$UPSTASH_REDIS_TLS_URL" GET "meridian:keeper:migration:mainnet:meridian-usdc"
   ```

3. **Never delete a lease with a non-null `hash` blindly.** Look up the hash on
   a Stellar block explorer (`stellar.expert`) or via `getTransaction` first.
   Only delete the key manually if the transaction is confirmed `SUCCESS`,
   `FAILED`, or past its 300s timeout.
4. After an Upstash failover to a fresh database (where all leases are empty),
   **wait at least 6 minutes (360s)** after the last keeper run before
   re-enabling `POST /api/v1/keepers/rebalance` so any in-flight transaction
   from before the outage has either landed or expired.

### Alert keeper cursor (`alert-keeper.md`)

Each vault's alert cursor is stored at
`meridian:keeper:alert:cursor:<network>:<vaultContractId>` as a plain ledger
number.

- If Upstash is replaced with an empty database, the alert keeper starts from
  the **current ledger** on its next run. It will **not** backfill events that
  occurred during the outage.
- **Recovery steps:**
  1. Check the vault's admin events on `stellar.expert` (or via
     `getRpcAdminHistory`) covering the outage window.
  2. If you want the alert keeper to replay from a specific ledger instead of
     skipping ahead, set the cursor explicitly before the next 5-minute tick:

```sh
redis-cli --tls -u "$UPSTASH_REDIS_TLS_URL" SET \
  "meridian:keeper:alert:cursor:mainnet:CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ" \
  "<LAST_AUDITED_LEDGER>"
```

## Switching the Soroban RPC URL

Each network currently has a single RPC endpoint configured in
`packages/shared/src/constants.ts` under `STELLAR_NETWORKS`:

- **Mainnet:** `https://mainnet.sorobanrpc.com`
- **Testnet:** `https://soroban-testnet.stellar.org`

There is no runtime environment variable override for the RPC URL yet. To fail
over to a backup Soroban RPC provider (for example, QuickNode, Ankr, Blockdaemon,
or a self-hosted Soroban RPC node):

1. **Immediate operator CLI access** (no deploy needed): pass `--rpc-url`
   directly to `stellar contract invoke` for emergency actions such as
   `set_paused` or `get_migration_snapshot`.
2. **Application and keeper failover:**
   - Update `STELLAR_NETWORKS.mainnet.rpcUrl` (or `testnet.rpcUrl`) in
     `packages/shared/src/constants.ts` to the backup endpoint URL.
   - Verify locally:

     ```sh
     pnpm --filter @meridian/shared build
     pnpm test
     ```

   - Push to `main` (or trigger a Vercel production deployment from the hotfix
     branch) so both `api/v1/` and `apps/web` pick up the new endpoint.
3. **Post-failover verification:**
   - Call `GET /api/v1/vaults` and confirm HTTP 200 with fresh on-chain data.
   - Trigger `.github/workflows/keepers.yml` via `workflow_dispatch` and confirm
     all four keeper steps return HTTP 200.

## Degraded-mode behavior and depositor communications

### What keeps working during off-chain outages

- **Depositor funds remain in the on-chain vault contract.** No off-chain
  outage can move or lock funds.
- **Withdrawals are never blocked** by Upstash, DeFiLlama, Vercel, or GitHub
  Actions outages (nor by `set_paused`). If the web UI is down, depositors can
  still redeem `mUSDC` shares directly against the mainnet vault contract
  (`CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ`) using any Stellar
  CLI or wallet that supports Soroban contract calls.
- **Mainnet vault reads** tolerate brief DeFiLlama blips via
  `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`.

### Depositor communication protocol

Communicate with depositors whenever an outage lasts longer than **15 minutes**
or affects deposits, withdrawals, or displayed balances.

- **Channels:** Primary community channel (Discord announcements) and status
  post on X/Twitter.
- **Cadence:** Initial notice within 15 minutes of confirmation; updates every
  30 minutes until resolved; final resolution notice + post-mortem link within
  24 hours for Sev-1/Sev-2 outages.
- **Always include:**
  1. What is affected (e.g. "Web dashboard deposits are temporarily unavailable").
  2. Explicit confirmation of fund safety ("Vault funds are safe on-chain; no
     action is required").
  3. Whether withdrawals are affected and, if the UI is down, a link to direct
     on-chain withdrawal instructions.
  4. Next update time.

## Outage tabletop scenarios

### Scenario 1: Upstash Redis outage during an active keeper window

- **Owner:** On-call Platform Engineer (Secondary: Protocol Engineer).
- **Trigger:** API strict endpoints return `503 RATE_LIMIT_BACKEND_UNAVAILABLE`;
  `.github/workflows/keepers.yml` fails on `rebalance` and `alert`.
- **Decision points:**
  - **T+0m (Detect):** Confirm Upstash status page and verify whether the outage
    is regional or account-wide. Confirm vault funds are unaffected.
  - **T+10m (Wait vs. Failover):** If Upstash reports no ETA or ETA > 20m,
    provision a scratch/failover Upstash database in an unaffected region and
    run the restore script from the latest daily `.jsonl` backup.
  - **T+20m (Safe cutover):** Update `UPSTASH_REDIS_REST_URL` and
    `UPSTASH_REDIS_REST_TOKEN` in Vercel and redeploy. Wait 360s from the last
    pre-outage migration keeper attempt before manually triggering `rebalance`.
  - **T+30m (Audit & Resolve):** Audit mainnet vault admin events on
    `stellar.expert` for the outage window, set the alert cursor if needed, and
    confirm `GET /api/v1/vaults` and all keepers return 200.

### Scenario 2: Mainnet Soroban RPC outage

- **Owner:** Protocol / Backend Engineer (Secondary: On-call Platform Engineer).
- **Trigger:** `GET /api/v1/vaults` and `GET /api/v1/positions/:publicKey` time
  out; keeper runs fail with Soroban RPC timeout errors (`MERIDIAN_KEEPER_RPC_TIMEOUT_MS`).
- **Decision points:**
  - **T+0m (Detect):** Test `https://mainnet.sorobanrpc.com` directly with a
    `getHealth` JSON-RPC call. Distinguish a single-provider RPC outage from a
    Stellar network-wide halt (check `stellar.expert` and `status.stellar.org`).
  - **T+10m (Switch provider):** If Stellar mainnet is healthy but
    `mainnet.sorobanrpc.com` is down or lagging > 10 ledgers, switch
    `STELLAR_NETWORKS.mainnet.rpcUrl` in `packages/shared/src/constants.ts` to
    the backup RPC provider, run tests, and deploy to Vercel.
  - **T+15m (Communicate):** If the switch is not yet live at T+15m, post an
    initial depositor notice stating that the UI is experiencing RPC delays and
    funds remain safe on-chain.
  - **T+30m (Verify):** Confirm vault reads, deposit/withdraw simulation, and a
    manual `workflow_dispatch` keeper run succeed against the backup RPC.

### Scenario 3: Vercel hosting outage (UI and API unavailable)

- **Owner:** Frontend / Ops Lead (Secondary: Protocol Engineer).
- **Trigger:** `https://usemeridian.vercel.app` returns 5xx/unreachable;
  GitHub Actions keeper workflow fails with connection errors.
- **Decision points:**
  - **T+0m (Detect):** Check `vercel-status.com` and confirm whether the outage
    is platform-wide or isolated to Meridian's deployment (e.g., bad deploy vs
    Vercel incident). If caused by a recent Meridian deploy, roll back
    immediately in the Vercel dashboard.
  - **T+15m (Communicate):** Post depositor notice confirming the web app is
    temporarily unreachable due to a hosting outage, vault funds are safe
    on-chain, and withdrawals remain possible directly via Stellar CLI.
  - **T+30m (Keeper continuity):** If the outage exceeds 30 minutes, check
    mainnet admin events manually on `stellar.expert` every 15 minutes (since
    the alert keeper is unreachable). Accrual and rebalancing can safely wait
    for Vercel recovery unless a large rate divergence or admin event occurs.
  - **Recovery:** Once Vercel recovers, verify `GET /api/v1/vaults`, trigger
    `.github/workflows/keepers.yml` via `workflow_dispatch`, and post the
    resolution notice.
