# Incident response

This page is the operational playbook for a live mainnet incident: the code
is fine, but something is actively going wrong (a suspected admin key
compromise, a keeper misbehaving, deciding whether to pause). It covers
three things that `apps/docs/overview/trust-model.md` (Trust Model, #726,
not yet merged as of this writing) and
[Mainnet Deployment](./mainnet-deployment.md#rollback-plan) both point here
for instead of duplicating: `set_paused`, admin key rotation, and
keeper-secret rotation.

**This page is not [Mainnet Deployment](./mainnet-deployment.md#rollback-plan)'s
"Rollback plan."** That page covers what to do when the _deployed code
itself_ needs to change (a bug in adapter or vault code). This page covers
what to do when the code is fine but something operational is wrong. If
you're not sure which applies: if the fix involves deploying new contract
code, it's #706's page; if it doesn't, it's this one.

## Detection: what's actually watching right now

**Read this before assuming an alert will tell you something is wrong.** As
of this writing, `MERIDIAN_ALERT_WEBHOOK_URL` is unset in production (see
[Admin-Event Alert Keeper](./alert-keeper.md#alert-destination)). The alert
keeper's cron runs on schedule but is a clean no-op, and **nothing is
currently watching the live mainnet vault for admin actions.** Configuring
that webhook is a prerequisite for everything below being actionable in
anything close to real time, not an optional enhancement. Until it's set,
detecting an incident depends on someone manually checking.

To manually check the live vault's admin action history right now (no
webhook required):

- The vault's admin events (`paused`, `transfer`, `accept`, `adapter`,
  `migrate`; see [Admin-Event Alert Keeper](./alert-keeper.md#which-events-alert))
  are visible on any Stellar block explorer against the mainnet vault
  address (`CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ`, see
  `packages/shared/src/constants.ts`), for example
  `stellar.expert/explorer/public/contract/CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ`.
  No code or RPC access needed, and this works even if every other tool on
  this page is unavailable.
- `getRpcAdminHistory` (`packages/stellar-sdk-helpers/src/admin-history.ts`)
  is the library function the alert keeper itself calls, filtering the
  vault's events server-side by the RPC. There is no HTTP endpoint wrapping
  it for ad-hoc queries yet, so using it directly means writing a small
  script against `packages/stellar-sdk-helpers` rather than curling
  anything. That is reasonable during an active incident if a block
  explorer's UI isn't giving you what you need (raw event data, a specific
  ledger range), but don't reach for it as step one when the explorer link
  above already answers "did anything happen."
- `get_migration_snapshot()` is directly callable read-only against the
  vault (any Stellar client, no special authority) and is the fastest way to
  confirm whether a `begin_migration` is currently pending and what it
  targets, without waiting on either tool above.

## Using `set_paused` to halt deposits

```sh
stellar contract invoke --id CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ \
  --source-account "$ADMIN_KEY" --network mainnet -- set_paused --paused true
```

**What this does and does not do**, per
Trust Model's "What the admin key can do" section: it
rejects new deposits. It does **not** block withdrawals. That's
deliberate, so pausing during an incident can never be the thing that traps
a depositor's funds. It also does **not** block `begin_migration`,
`migrate_adapter`, `set_adapter`, or admin rotation. Pausing alone does not
stop an in-progress malicious migration; it only stops new deposits from
being added to whatever situation is unfolding.

**When to reach for it:** a suspected admin key compromise, a keeper
submitting transactions that don't look right, or any situation where you
want to stop new deposit exposure while you investigate, even before you've
confirmed whether the situation is actually dangerous.
Unpausing (`set_paused false`, same command) is equally immediate once
resolved. Because it costs so little (no funds at risk, no time pressure to
get the decision exactly right) and reverses instantly, default to pausing
when investigating anything ambiguous rather than trying to fully diagnose
the situation first. The failure mode of pausing unnecessarily is a few
minutes of blocked deposits; the failure mode of not pausing when you should
have is measured in exactly what this page exists to prevent.

## Admin key rotation via `transfer_admin`/`accept_admin`

```sh
# Current admin nominates a successor. Authority does NOT move yet.
stellar contract invoke --id CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ \
  --source-account "$ADMIN_KEY" --network mainnet -- transfer_admin --new_admin "$NEW_ADMIN"

# The nominee accepts with their own signature -- the old admin cannot do this step.
stellar contract invoke --id CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ \
  --source-account "$NEW_ADMIN_KEY" --network mainnet -- accept_admin
```

**Planned rotation** (scheduled key refresh, a signer leaving the team): run
both steps normally, confirm the new admin can sign, then decommission the
old key on your own timeline.

**Emergency rotation** (suspected compromise of the current admin key):
speed matters more than in the planned case, for the reason
Trust Model's "Key-loss and key-compromise consequences" section
states plainly: there is no on-chain recovery if the current key is lost or
if an attacker completes their own `transfer_admin`/`accept_admin` first.
Concretely:

1. **Pause first** (previous section). It costs nothing and buys time
   regardless of how the rotation race goes.
2. **Nominate the emergency successor immediately** with whatever admin
   access you still have. If the current key is only _suspected_
   compromised, not confirmed unusable, don't wait for confirmation before
   nominating. Nominating doesn't move authority, so there's no downside
   to doing it early, and every minute of delay is a minute an attacker with
   the same key could nominate their own successor first.
3. **Have the successor's `accept_admin` ready to submit the moment
   nomination lands.** Pre-sign or pre-stage this rather than starting to
   prepare it after step 2 completes.
4. If a malicious `transfer_admin` is discovered _before_ its matching
   `accept_admin` has landed, there is no way to cancel someone else's
   pending nomination directly. The legitimate admin can, however,
   immediately call `transfer_admin` again with the legitimate successor,
   which overwrites the malicious nomination (`transfer_admin`'s doc
   comment in `packages/contracts/vault/src/lib.rs` confirms it "overwrites
   any prior, not-yet-accepted nomination"). This only works if the
   legitimate admin key can still sign. If the same compromised key is what
   an attacker used to submit the malicious nomination in the first place,
   overwriting it doesn't help, since the attacker can just resubmit.

## Keeper-secret rotation

Three keepers, three different secrets, and three very different stakes if
one leaks. Treat them accordingly rather than as one undifferentiated
"rotate the keeper key" task:

- **`MERIDIAN_KEEPER_SECRET_KEY`** (accrue keeper). `accrue()` is
  permissionless, so this key only needs to be a funded Stellar account,
  not anything vault-privileged. Rotation is low-stakes: generate a new funded
  key, update the secret in your deployment's secret store, redeploy.
  Nothing vault-side changes; the old key simply stops being used.
- **`MERIDIAN_MIGRATION_KEEPER_SECRET_KEY`** (migration keeper). Per
  [Migration Keeper](./migration-keeper.md#signing-key-and-trust-model),
  **this key must be the vault's actual admin address**, because
  `migrate_adapter` is admin-gated, so this secret _is_ the admin key in
  practice.
  "Rotating the migration keeper's secret" and "rotating the vault admin"
  are the same operation here, not two separate ones: follow the admin key
  rotation procedure above, then update
  `MERIDIAN_MIGRATION_KEEPER_SECRET_KEY` in the deployment secret store to
  the new admin's secret once `accept_admin` has landed. Treat any suspected
  leak of this specific secret with the same urgency as a suspected admin
  key compromise, because that is exactly what it is.
- **`MERIDIAN_ALERT_WEBHOOK_URL`** (alert keeper). Lowest stakes of the
  three: it's a destination URL, not a signing key, and per "Detection"
  above it isn't even configured in production yet. If it leaks (posted
  somewhere public, a former team member retains it), anyone with it can
  send fake-looking alerts to your Slack/Discord or see real ones. That is
  an annoyance and a possible confusion vector during a real incident, not
  a fund-safety issue. Rotate by generating a new incoming-webhook URL from
  Slack/Discord and updating the environment variable; no coordination with
  on-chain state needed.
