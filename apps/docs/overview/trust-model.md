# Trust model

Meridian's vault holds real user USDC. This page states, in one place, what
the `ADMIN` key can and cannot do, what happens if it's lost or compromised,
and what that means for a depositor or an auditor evaluating custody risk.
The goal is to save the reader from reconstructing it from `docs/contracts.md`,
`SECURITY.md`, and scattered issue threads (#557 in
particular). Nothing here is new policy: it's a consolidation of decisions
already made and already implemented, with citations back to the source.

**Current status, stated plainly:** Meridian is live on Stellar mainnet (see
[Mainnet Deployment](../operations/mainnet-deployment.md#mainnet-deployment-record))
holding real depositor funds. Per that page's own go-live checklist, as of
this writing **no independent security audit has been commissioned, and
`ADMIN` key custody has not yet been finalized to the hardware-backed or
multisig standard the mainnet prerequisites call for.** This page describes
what the contract's code enforces regardless of who holds `ADMIN` or how
well; it does not represent that those two items are resolved. Check
[Mainnet Deployment](../operations/mainnet-deployment.md#go-live-checklist)
for their current status before relying on this page for a custody decision.

## What the admin key can do

A single `Address` stored as `ADMIN` gates every one of these. There is no
per-action co-signer or committee check inside the contract itself. Whatever
`ADMIN` resolves to (a plain key, a hardware-backed key, a Stellar-native
multisig account) _is_ the entire on-chain access-control model for all five:

- **`set_paused(bool)`**: an emergency switch that rejects new deposits
  while set. **Withdrawals are deliberately left callable regardless of
  pause state**, by design. See the doc comment on `set_paused` in
  `packages/contracts/vault/src/lib.rs`, which states plainly that
  "a pause can never trap funds." An admin, malicious or not, cannot use
  pause to lock depositors out of their own funds.
- **`set_adapter(new_adapter)`**: repoints the vault at a different yield
  adapter, but only when the vault holds no position at all
  (`TOTAL_SH == 0` and `ADPT_SH == 0`). This is a bootstrap/recovery tool
  for an empty vault, not a live-migration path. See `migrate_adapter`
  below for the mechanism that exists for a vault with real depositors.
- **`begin_migration(new_adapter)` / `migrate_adapter(new_adapter, max_slippage_bps)`**:
  the two-phase, live-migration path. `begin_migration` snapshots the
  target adapter's reported value, then `migrate_adapter` can only execute
  once `MIN_LEDGER_GAP` (17,280 ledgers, ~1 day) has elapsed since that
  snapshot, and only within `MAX_ADMIN_SLIPPAGE_BPS` (500 bps, 5%) of
  value loss versus the snapshot. Both limits are compiled-in constants in
  `packages/contracts/vault/src/storage.rs`,
  not admin-adjustable at call time. See the "Parameter selection" table
  in [Mainnet Deployment](../operations/mainnet-deployment.md#parameter-selection)
  for their exact values, and #557, the incident that established both
  limits (previously: unbounded slippage, ~1-minute timelock).
- **`transfer_admin(new_admin)` / `accept_admin()`**: a two-step handoff,
  in which the current admin nominates a successor, but authority only actually
  moves once the nominee calls `accept_admin` with their own signature.
  See "Key-loss and key-compromise consequences" below for what this
  design does and does not protect against.

That's the complete list. `deposit`, `withdraw`, `accrue` (the yield-accrual
keeper call), and every read-only getter require no special authority beyond
the caller's own signature where a signature is required at all.

## What the admin key structurally cannot do

- **There is no upgrade entry point, for the admin or anyone else.** See
  "Contract immutability" in `docs/contracts.md`:
  no `update_current_contract_wasm` or equivalent exists anywhere in the
  vault or either adapter. An admin-gated `upgrade()` was deliberately
  rejected specifically because it would compound the exact admin-authority
  risk this page documents, for a problem `migrate_adapter`/full-cutover
  redeployment already solves. Nothing on this page changes if the admin
  key is compromised, because there is no code-level lever labeled
  "upgrade" for a compromised key to pull.
- **Admin actions cannot touch individual depositor balances directly.**
  `set_adapter`/`migrate_adapter` move the vault's _aggregate_ adapter
  position; per-depositor accounting (`Principal`, `Entry`, mUSDC balances)
  is denominated in vault shares and is untouched by either call. See
  "Vault (`meridian-vault`)" in `docs/contracts.md`.
  There is no admin call that debits one depositor's shares or mints
  uncollateralized ones.
- **`migrate_adapter` cannot move funds with unlimited loss, and cannot
  move them instantly.** `MAX_ADMIN_SLIPPAGE_BPS` bounds the loss a single
  call can authorize regardless of the `max_slippage_bps` argument passed;
  `MIN_LEDGER_GAP` bounds how soon after `begin_migration` it can execute
  at all. Both are compiled into the deployed WASM, not runtime-configurable
  by `ADMIN` or anyone else without a full redeploy.
- **Pause cannot trap funds.** Covered above, worth restating here: pause
  is a deposit-only brake, not a custody mechanism.

## Key-loss and key-compromise consequences

**There is no on-chain recovery from a lost or destroyed `ADMIN` key.**
`transfer_admin` requires the _current_ admin's `require_auth()` (see the
function's doc comment in
`packages/contracts/vault/src/lib.rs`).
If that key is gone before a successor is nominated and has accepted, no
contract-level path replaces it. This is the same trade-off
`docs/contracts.md` makes
for code immutability, applied to the admin role specifically: any recovery
mechanism that didn't require the current admin's own signature would itself
be a takeover path for anyone else who found it. `deposit`/`withdraw` are not
admin-gated at all, so depositor funds remain accessible even if `ADMIN`
becomes permanently unreachable. What's lost is the ability to pause, swap
adapters, or migrate going forward, not depositor access to their own funds.

**A compromised `ADMIN` key cannot drain the vault in a single
transaction**, per the bounds in "What the admin key can do" above: a
`migrate_adapter` call is capped at 5% loss versus the pre-migration
snapshot and cannot execute until a day after the matching `begin_migration`
call. The vault's own doc comments name this explicitly. `begin_migration`'s
doc comment states plainly that the delay itself is
`the only thing standing between a leaked key and the vault's entire
position moving to an address the attacker controls`; `migrate_adapter`'s
own doc comment makes the same point independently, in its own words, citing the
same `MIN_LEDGER_GAP` mechanism as `what actually stands between a
compromised key and total loss`. Both are in
`packages/contracts/vault/src/lib.rs`. The timelock is a
detection-and-reaction _window_, not a mechanism that prevents the outcome
outright. It only has value if something is actually watching (the
[alert keeper](../operations/alert-keeper.md)) and someone is positioned to
react. `migrate_adapter`'s doc comment names the same two options this page
does: rotating the admin key via `transfer_admin`/`accept_admin`, or pausing
deposits, before the cooldown elapses. See the
"Rollback plan" section of
[Mainnet Deployment](../operations/mainnet-deployment.md#rollback-plan) for
what reacting in time actually involves, and the incident-response runbook
tracked as **#721** (not yet written as of this page) for the operational
playbook once it exists. This page describes what the contract enforces;
#721 is where "what do we actually do right now" belongs, and duplicating
that content here would only let the two drift out of sync.

**`set_adapter` and one-shot `set_paused` calls are not similarly bounded.**
Unlike `migrate_adapter`, neither has a slippage cap or a timelock, because
neither moves funds on its own: `set_adapter` only succeeds against an
empty vault (see "What the admin key can do"), and `set_paused` only blocks
new deposits. A compromised key exercising either causes operational
disruption (a live vault effectively frozen to new deposits, or a repointed
empty vault) rather than fund loss.

**A compromised key that also completes `transfer_admin`/`accept_admin`
before the legitimate admin reacts is a full, permanent handover.** The
two-step design (see "What the admin key can do") protects against a
_mistyped_ successor address, not a malicious one with its own signature
ready to call `accept_admin` immediately. Detecting and reacting to a
suspicious `transfer_admin` nomination before its matching `accept_admin`
lands is the same race the migration timelock exists for, but without a
compiled-in delay to widen the window. This is the highest-severity
incident category #721 will need to cover.

## See also

- `docs/contracts.md`: the contract-architecture
  reference this page assumes as background (adapter model, share pricing,
  immutability rationale).
- `SECURITY.md`: a vulnerability _disclosure_ policy, covering
  how to report a finding, not a description of the trust model itself.
- [Mainnet Deployment](../operations/mainnet-deployment.md): the current
  live deployment's actual parameter values, addresses, and go-live
  checklist status, including the two open items ("ADMIN key custody" and
  "security audit") this page's "Current status" section refers to.
- **#721** (incident-response runbook, not yet written): the operational
  playbook for what to actually do during a live incident (a suspected key
  compromise, a decision to pause, rotating a keeper secret). This page
  documents what the contract _enforces_; #721 will document what
  _people_ do in response.
