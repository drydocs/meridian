# Admin-Event Alert Keeper

The vault emits on-chain events for admin actions: `paused`, `transfer`,
`accept`, `adapter`, and `migrate` ([#698](https://github.com/drydocs/meridian/issues/698)). Nothing consumed that feed until
now, so an unexpected pause, an admin-key rotation, or an adapter migration
would only be noticed by whoever happened to check the app. This keeper
watches for those events and posts a webhook alert as soon as one lands.

## Schedule

The same GitHub Actions workflow that runs the other keepers
(`.github/workflows/keepers.yml`) calls `POST /api/v1/keepers/alert` every 5
minutes, authenticating with the same `CRON_SECRET` bearer token as
`accrue`/`rebalance`. See [Blend Accrual Keeper](./accrual-keeper.md#schedule)
for why this lives in GitHub Actions rather than Vercel Cron.

A 5-minute interval is tighter than the accrual keeper's 15 minutes: these are
exactly the actions an operator needs to know about immediately, not on the
same staleness budget as a TVL/APY cache.

## Alert Destination

Set `MERIDIAN_ALERT_WEBHOOK_URL` to a Slack or Discord incoming-webhook URL.
Every alert POSTs a JSON body containing both `text` (Slack's field) and
`content` (Discord's field), so the same configuration works against either
service without picking a payload shape up front; whichever field a service
doesn't recognise is ignored.

`MERIDIAN_ALERT_WEBHOOK_URL` is unset in production as of the mainnet launch
(2026-09-07): the keeper's cron runs on schedule, but `isAlertKeeperConfigured`
makes it a clean no-op (`{status: "disabled"}`, not an error) until this is
set. Discord is the intended destination, not yet wired up. Nothing is
currently watching the live mainnet vault for the admin actions below.

## Alert Payload

Every alert is `POST`ed as `Content-Type: application/json` with two string
fields. Slack renders `text`; Discord renders `content`. The keeper puts the
same complete message in both fields so either destination works unchanged.

| Field     | Type   | Meaning                                      | Safe to display |
| --------- | ------ | -------------------------------------------- | --------------- |
| `text`    | string | Complete alert message for Slack.            | Yes             |
| `content` | string | The same complete alert message for Discord. | Yes             |

There is no separate event type, vault, or ledger field in the JSON body. The
message text is the identifying record: it starts with `[meridian]`, followed
by the vault id, the action, and the ledger sequence. Addresses are shortened
to the first eight and last four characters. The payload contains only public
on-chain identifiers and ledger numbers, so it is safe to display in a chat
channel.

| Alert type  | Identifying message fragment             | Event data in the message                                           |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `paused`    | `deposits PAUSED` or `deposits unpaused` | Ledger sequence.                                                    |
| `transfer`  | `admin transfer nominated to`            | Shortened new admin address and ledger sequence.                    |
| `adapter`   | `adapter switched to`                    | Shortened new adapter address and ledger sequence.                  |
| `migrate`   | `migrated adapter from`                  | Shortened old and new adapter addresses and ledger sequence.        |
| `mig_begin` | `migration cooldown started for`         | Shortened target adapter, ledger, and `earliest completion ledger`. |

### Payload Examples

#### `paused`

```json
{
  "text": "[meridian] meridian-usdc: deposits PAUSED at ledger 300",
  "content": "[meridian] meridian-usdc: deposits PAUSED at ledger 300"
}
```

Unpausing uses the same type with `deposits unpaused` in place of `deposits
PAUSED`.

#### `transfer`

```json
{
  "text": "[meridian] meridian-usdc: admin transfer nominated to GC7MCAT5...OUIN at ledger 300",
  "content": "[meridian] meridian-usdc: admin transfer nominated to GC7MCAT5...OUIN at ledger 300"
}
```

#### `adapter`

```json
{
  "text": "[meridian] meridian-usdc: adapter switched to CABAEAQC...FNSZ at ledger 300",
  "content": "[meridian] meridian-usdc: adapter switched to CABAEAQC...FNSZ at ledger 300"
}
```

#### `migrate`

```json
{
  "text": "[meridian] meridian-usdc: migrated adapter from CAAQCAIB...C526 to CABAEAQC...FNSZ at ledger 300",
  "content": "[meridian] meridian-usdc: migrated adapter from CAAQCAIB...C526 to CABAEAQC...FNSZ at ledger 300"
}
```

#### `mig_begin`

```json
{
  "text": "[meridian] meridian-usdc: migration cooldown started for CABAEAQC...FNSZ at ledger 300 (earliest completion ledger 17380)",
  "content": "[meridian] meridian-usdc: migration cooldown started for CABAEAQC...FNSZ at ledger 300 (earliest completion ledger 17380)"
}
```

## Acknowledging Delivery

A custom receiver should enqueue the alert and return a 2xx response (200 is
conventional) after accepting it. The keeper treats every 2xx response as
success and does not inspect the response body. Do not wait for downstream
processing before responding; a slow receiver can exceed the webhook timeout
(`MERIDIAN_KEEPER_RPC_TIMEOUT_MS`, default 10 seconds) and cause a retry.

A non-2xx response, timeout, or network error is retried with the configured
backoff, and the cursor is not advanced past the failed event. These retries,
and a lost success response, can redeliver an identical payload. Receiver
handlers should therefore be idempotent, for example by deduplicating on the
exact message text or on the vault, action, and ledger it contains.

## Planned Signed Delivery

Alerts are currently unsigned. [#1342](https://github.com/drydocs/meridian/issues/1342)
plans to add `X-Meridian-Signature`, `X-Meridian-Timestamp`, and
`X-Meridian-Delivery` headers, with an HMAC-SHA256 signature over the
timestamp, delivery ID, and raw request body. Receivers should not require
these headers until that work lands, or they will reject every current alert.
Once deployed, verify the signature against the raw body before acting on the
payload, reject timestamps outside the documented replay window, and track the
delivery ID so a replayed request is not acknowledged twice.

## Which Events Alert

Only `paused`, `transfer`, `adapter`, `migrate`, and `mig_begin` trigger an
alert.
`accept_admin` is deliberately excluded: it is the second half of an
already-alerted `transfer_admin` nomination, not a new risk on its own.

## Cursor Tracking

Each known vault (`KNOWN_POOLS` entries with `protocol: "meridian"` and a
`contractId` set for the running network, the same filter the accrual
keeper's discovery uses) has its own next-ledger-to-scan cursor, stored in
the shared Upstash Redis store under
`meridian:keeper:alert:cursor:<network>:<vaultContractId>`. Every run reads
that cursor, fetches admin events since it via `getRpcAdminHistory`, and
advances the cursor only as far as the last event it actually alerted on (or
that needed no alert, e.g. `accept_admin`). This is the same store
`keeper-heartbeat.ts` uses for last-successful-run timestamps, reused here
for a ledger number instead: both are a last-write-wins value with no
lease/CAS semantics, since the worst a race costs here is a duplicate or
delayed alert, never an incorrect one.

On first run, with no cursor stored yet, the keeper starts from the current
ledger rather than replaying the vault's entire admin history as a flood of
alerts.

If a webhook send fails, the persisted cursor stays at or before that event's
ledger, even if an earlier action in the same ledger succeeded or needed no
alert. The failed event and anything after it in the same page are retried
on the next scheduled run instead of being silently skipped. Because the
cursor stores only a ledger number, replaying that ledger can repeat alerts
that were already delivered successfully before the failure. A lost HTTP
response can also cause a duplicate alert. The cursor key and numeric store
format are unchanged; no migration is needed.

## Retry And Failure Handling

Configure the same knobs the other keepers share:

- `MERIDIAN_KEEPER_MAX_ATTEMPTS` default `3`
- `MERIDIAN_KEEPER_RETRY_BASE_DELAY_MS` default `1000`
- `MERIDIAN_KEEPER_RPC_TIMEOUT_MS` default `10000` (also used as the webhook
  request timeout)

Failures are logged with the vault id, contract id, stage (`discover` or
`send`), attempt count, and error summary, and included in the endpoint
response. If at least one failure occurs, the endpoint returns HTTP 500 so
the scheduled run is observable instead of silently passing.
