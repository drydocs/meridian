# Contract Storage and TTL Reference

This page is the source-backed inventory of Meridian's contract storage. Key
names and value types below are taken from the contract crates; test-only
fixtures are intentionally excluded.

## TTL policy

Soroban storage entries expire when their TTL reaches zero. A call cannot read
an expired entry, so keepers must extend entries while they still exist.

| Storage class                     | Policy                                                                                                                                     | Source                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Contract instance storage         | `INSTANCE_BUMP = 30 * DAY_IN_LEDGERS` and `INSTANCE_THRESHOLD = INSTANCE_BUMP - DAY_IN_LEDGERS` (30 days, refreshed below 29 days).        | `packages/contracts/adapter-common/src/lib.rs` |
| Vault position persistent storage | `POSITION_BUMP = 120 * DAY_IN_LEDGERS` and `POSITION_THRESHOLD = POSITION_BUMP - 7 * DAY_IN_LEDGERS` (120 days, refreshed below 113 days). | `packages/contracts/vault/src/lib.rs`          |
| mUSDC allowance temporary storage | The stored `expiration_ledger` is the allowance's expiry. An expired allowance is read as zero.                                            | `packages/contracts/musdc-token/src/lib.rs`    |

`DAY_IN_LEDGERS` is 17,280 ledgers, approximately one day at five seconds per
ledger. Instance-bearing adapter entry points call `extend_instance`. Vault
deposits, withdrawals, transfers, and the permissionless
`extend_position_ttl(address)` path extend the relevant position records.

## Vault (`vault`)

All keys in this table are instance keys unless marked persistent.

| Key                  | Value                                                     | TTL / bump                                | Recovery and owner                                                                                                                  |
| -------------------- | --------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`              | `Address`                                                 | Instance policy                           | Constructor/admin flow; if expired, recover through the deployment/migration plan rather than treating the vault as uninitialized.  |
| `PEND_ADM`           | pending admin `Address`                                   | Instance policy                           | Cleared by `accept_admin`; re-nominate with `transfer_admin` if still present.                                                      |
| `USDC`               | token `Address`                                           | Instance policy                           | Immutable deployment configuration; restore through a controlled replacement/migration if the instance record is gone.              |
| `MUSDC`              | mUSDC token `Address`                                     | Instance policy                           | Same controlled replacement/migration path as other configuration.                                                                  |
| `ADAPTER`            | active adapter `Address`                                  | Instance policy                           | Read before migration; if unavailable, use deployment records and an authorized replacement plan.                                   |
| `TREASURY`           | fee recipient `Address`                                   | Instance policy                           | Constructor-fixed configuration.                                                                                                    |
| `TOTAL_SH`           | total mUSDC shares, `i128`                                | Instance policy                           | Reconcile against mUSDC supply and deployment history; never infer a missing value as zero.                                         |
| `ADPT_SH`            | adapter shares, `i128`                                    | Instance policy                           | Reconcile with the adapter's `total_shares()` before migration or recovery.                                                         |
| `PAUSED`             | `bool`                                                    | Instance policy; absent reads as `false`  | Check admin state and set deliberately after recovery.                                                                              |
| `LOCKED`             | temporary reentrancy sentinel, `bool`                     | Present only during a guarded call        | It is removed before a guarded call returns; an unexpected value should be investigated, not overwritten casually.                  |
| `MIG_SNAP`           | `MigrationSnapshot { adapter, total_assets, ledger_seq }` | Instance policy while migration is active | Use the matching `migrate_adapter` flow; do not reuse an old snapshot.                                                              |
| `MIG_ACT`            | active sentinel, `i128` (`0` or `1`)                      | Instance policy                           | Clear as part of a completed migration; an active value means the cooldown/snapshot flow is incomplete.                             |
| `Entry(address)`     | first-entry ledger timestamp, `u64`                       | Persistent position policy                | `extend_position_ttl(address)` while present; if expired, reconstructing the timestamp requires an explicit historical-data policy. |
| `Principal(address)` | net deposited USDC, `i128`                                | Persistent position policy                | Extend with the position; if missing, do not treat it as zero because it is cost-basis history.                                     |

The vault deliberately does not store a per-address share balance. Current
ownership is read from mUSDC, while `Entry` and `Principal` preserve the
position's time and cost basis.

## mUSDC token (`musdc-token`)

| Key                         | Storage class | Value                                                     | TTL / recovery                                                                                                                          |
| --------------------------- | ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`                     | Instance      | vault `Address`                                           | Instance policy; deployment configuration.                                                                                              |
| `DECIMALS`                  | Instance      | `u32`                                                     | Instance policy; deployment metadata.                                                                                                   |
| `NAME`                      | Instance      | token `String`                                            | Instance policy; deployment metadata.                                                                                                   |
| `SYMBOL`                    | Instance      | token `Symbol`/string value                               | Instance policy; deployment metadata.                                                                                                   |
| `TOTAL_SUP`                 | Instance      | total supply, `i128`                                      | Instance policy; reconcile against balances if recovery is required.                                                                    |
| `Balance(address)`          | Persistent    | balance, `i128`                                           | No contract-specific bump helper exists here; extend while the account is active and recover from token/deployment history if archived. |
| `Allowance(owner, spender)` | Temporary     | `AllowanceValue { amount: i128, expiration_ledger: u32 }` | Expires at `expiration_ledger`; re-approve rather than attempting to restore an expired approval.                                       |

## Shared adapter keys

Every Blend and DeFindex adapter uses these instance keys from
`adapter-common`:

| Key     | Value                  | TTL / recovery                                                                                                                     |
| ------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT` | owning vault `Address` | 30-day instance bump, refreshed below 29 days by `extend_instance`. Reconnect only through a controlled deployment/migration path. |
| `USDC`  | USDC token `Address`   | Same instance policy.                                                                                                              |

## Blend adapter (`blend-adapter`)

| Key     | Storage class | Value                        | TTL / recovery                                                                                            |
| ------- | ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POOL`  | Instance      | Blend pool `Address`         | Shared 30-day instance policy; initialize a replacement adapter if configuration is irrecoverably absent. |
| `TOTAL` | Instance      | cached adapter total, `i128` | Shared 30-day instance policy; refresh from Blend before relying on a recovered cache.                    |

The adapter's authoritative protocol position is held by Blend. `TOTAL` is a
cache/accounting value, not a substitute for the pool's live position.

## DeFindex adapter (`defindex-adapter`)

| Key        | Storage class | Value                    | TTL / recovery                                                                                  |
| ---------- | ------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `DFXVAULT` | Instance      | DeFindex vault `Address` | Shared 30-day instance policy; use the deployment record or a controlled replacement if absent. |

The DeFindex adapter reads its position and valuation from the DeFindex vault;
it does not maintain a production persistent position map of its own.

## Operational recovery checklist

1. Confirm the ledger and contract address before concluding that a key is
   archived; an absent read is not proof that the value was ever zero.
2. For a live vault position, call `extend_position_ttl(address)` while both
   persistent records still exist. For an active adapter, call a state-changing
   entry point that invokes `extend_instance`.
3. If a record is already archived, use indexed ledger history and the relevant
   deployment/migration procedure. Do not silently recreate `Principal`, share
   supply, adapter shares, or token balances with guessed zeros.
4. Treat an expired mUSDC allowance as normal authorization expiry and ask the
   owner to approve again.

See the [vault architecture](./vault-contract) and the [mainnet deployment
TTL parameters](../operations/mainnet-deployment) for the surrounding
operational context.
