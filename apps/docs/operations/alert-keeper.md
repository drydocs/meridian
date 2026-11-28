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

Set `MERIDIAN_ALERT_WEBHOOK_URL` to a Slack or Discord incoming-webhook URL, or an internal alert receiver service.
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

## Signed Delivery

### Webhook Signatures and Replay Protection

Signing applies to receivers you operate. Slack and Discord incoming webhooks cannot verify these headers, so alerts sent to them carry the headers but nothing checks them.

To ensure alerts cannot be forged by an entity learning the webhook URL, every outgoing webhook request is signed with HMAC-SHA256 using a shared secret (`MERIDIAN_ALERT_WEBHOOK_SECRET`) and includes replay protection headers:

- `X-Meridian-Signature`: Hex-encoded HMAC-SHA256 digest formatted as `sha256=<hex_digest>`.
- `X-Meridian-Timestamp`: Unix epoch timestamp (in seconds) when the alert was dispatched.
- `X-Meridian-Delivery`: Unique UUID identifying this specific delivery attempt.

The signature is computed over `${timestamp}.${deliveryId}.${body}`:

```ts
const payload = `${timestamp}.${deliveryId}.${body}`;
const signature =
  "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
```

### Fail-Closed Behavior on Deployed Environments

On deployed environments (`VERCEL_ENV` set, e.g. `production` or `preview`, or `NODE_ENV === "production"`), `loadAlertKeeperConfig` strictly requires `MERIDIAN_ALERT_WEBHOOK_SECRET` when `MERIDIAN_ALERT_WEBHOOK_URL` is set. If the secret is omitted, the keeper fails closed and refuses to dispatch unsigned alert payloads.

### Local Development Without a Secret

When `MERIDIAN_ALERT_WEBHOOK_SECRET` is unset outside a deployed environment, alerts are sent unsigned, without the three `X-Meridian-*` headers, so a local receiver keeps working. A deployed environment refuses to start the keeper without the secret.

### Receiver Verification Algorithm

A receiving service should verify the authenticity and freshness of each request before processing:

1. Extract `X-Meridian-Signature`, `X-Meridian-Timestamp`, and `X-Meridian-Delivery` headers. Reject the request with HTTP 400 if any header is missing.
2. Parse `X-Meridian-Timestamp` as an integer. Reject if the absolute time difference `|now - timestamp|` exceeds the tolerance window (default: 300 seconds / 5 minutes) to protect against replay attacks.
3. Compute the expected signature over `${timestamp}.${deliveryId}.${rawBody}` using the shared secret.
4. Compare the expected signature against `X-Meridian-Signature` using a constant-time comparison (such as `crypto.timingSafeEqual`) to prevent timing attacks.
5. Reject a delivery ID you have already seen within the tolerance window. The signature and timestamp alone let a captured request replay freely until the window closes, so the receiver must remember recent `X-Meridian-Delivery` values and refuse repeats. A retry of a failed delivery uses a new delivery ID, so keep handlers idempotent as described above.

The `@meridian/stellar-sdk-helpers` package provides reference verification helpers:

```ts
import {
  verifyAlertWebhookSignature,
  isAlertWebhookSignatureValid,
} from "@meridian/stellar-sdk-helpers";

// In your webhook receiver handler (e.g. Express / Fastify):
const result = verifyAlertWebhookSignature(
  req.headers,
  rawBody,
  webhookSecret,
  {
    toleranceSeconds: 300, // 5-minute replay window
  }
);

if (!result.valid) {
  return res.status(401).send({ error: result.error });
}
```

### Key Rotation Procedure

To rotate the webhook shared secret (`MERIDIAN_ALERT_WEBHOOK_SECRET`) without dropping alerts:

1. **Dual-secret support on receiver**: Update the receiver service to accept signatures computed with either the current secret or a new secret (or verify against new secret first and fallback to current secret).
2. **Update environment secret**: Set `MERIDIAN_ALERT_WEBHOOK_SECRET` in the keeper's deployment environment (e.g. Vercel Project Settings > Environment Variables) to the new secret.
3. **Trigger verification run**: Trigger the alert keeper endpoint or await the next 5-minute cron interval, confirming in receiver logs that alerts are received with signatures valid under the new secret.
4. **Decommission old secret**: Remove the old secret from the receiver service configuration.

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
