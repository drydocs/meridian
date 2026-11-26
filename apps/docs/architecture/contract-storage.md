# Contract Storage and TTL Reference

This page is the operator and contributor reference for persistent state in Meridian's Soroban contracts. It covers only keys used by deployed contract code; keys declared inside `#[cfg(test)]` mock contracts are test fixtures, not protocol storage.

Storage has ledger-local lifetime and is independent of contract source upgrades:

- **Instance storage** holds contract-wide configuration and counters. An instance entry and the keys in it share the contract instance's lifetime.
- **Persistent storage** holds entries that outlive a single invocation, including per-address position and token records.
- **Temporary storage** holds short-lived approvals and does not represent durable protocol state.

Ledgers close at approximately five-second intervals. One day is `17_280` ledgers.

## Shared TTL policy

| Policy           |                           Bump |                      Threshold | Used by                                                              |
| ---------------- | -----------------------------: | -----------------------------: | -------------------------------------------------------------------- |
| Adapter instance |    30 days (`518_400` ledgers) |    29 days (`501_120` ledgers) | Shared adapter instance keys and active state-changing adapter calls |
| Vault instance   |    30 days (`518_400` ledgers) |    29 days (`501_120` ledgers) | Vault instance state                                                 |
| Vault position   | 120 days (`2_073_600` ledgers) | 113 days (`1_952_640` ledgers) | `Entry(Address)` and `Principal(Address)`                            |
| Contract/default |          None in contract code |       Host/Soroban default TTL | mUSDC instance, persistent, and temporary entries                    |

The shared adapter constants are [`INSTANCE_BUMP`, `INSTANCE_THRESHOLD`, and `extend_instance()`](https://github.com/drydocs/meridian/blob/main/packages/contracts/adapter-common/src/lib.rs). The vault constants and position policy are in [`vault/src/lib.rs`](https://github.com/drydocs/meridian/blob/main/packages/contracts/vault/src/lib.rs) and [`vault/src/storage.rs`](https://github.com/drydocs/meridian/blob/main/packages/contracts/vault/src/storage.rs).

When an instance or persistent entry reaches its threshold, callers that implement the policy run `extend_ttl(threshold, bump)`. The bump is based on remaining lifetime: an entry is extended only below the threshold, and the resulting lifetime is the bump amount.

## Vault contract

Owner: [`vault`](https://github.com/drydocs/meridian/tree/main/packages/contracts/vault).

### Vault instance keys

| Key        | Type                      | Purpose                                                                  | Bump threshold                                                              | Recovery if archived                                                                                                        |
| ---------- | ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN`    | `Address`                 | Current vault administrator                                              | 29 days, 30-day bump on state-changing calls                                | Restore the vault instance footprint, then normal calls. Reinitialize only for an actually uninitialized legacy deployment. |
| `PEND_ADM` | `Address`                 | Pending accepted admin change                                            | 29 days, 30-day bump on admin-state calls                                   | Restore the instance; the pending change is only lost if the whole instance is unavailable.                                 |
| `USDC`     | `Address`                 | USDC token contract                                                      | 29 days, 30-day bump on state-changing calls                                | Restore the instance before using the vault.                                                                                |
| `MUSDC`    | `Address`                 | mUSDC share-token contract                                               | 29 days, 30-day bump on state-changing calls                                | Restore the instance before using the vault.                                                                                |
| `ADAPTER`  | `Address`                 | Active yield adapter                                                     | 29 days, 30-day bump on state-changing calls                                | Restore the instance before migration or holder operations.                                                                 |
| `TREASURY` | `Address`                 | Constructor-fixed performance-fee treasury                               | 29 days, 30-day bump on state-changing calls                                | Restore the instance; changing it requires a fresh vault deployment.                                                        |
| `TOTAL_SH` | `i128`                    | mUSDC supply accounted by the vault                                      | 29 days, 30-day bump on state-changing calls                                | Restore the instance; never reconstruct this by minting.                                                                    |
| `ADPT_SH`  | `i128`                    | Active adapter shares accounted by the vault                             | 29 days, 30-day bump on state-changing calls                                | Restore the instance, then let the next vault operation reconcile from the live adapter.                                    |
| `PAUSED`   | `bool`                    | Deposit-pause state                                                      | 29 days, 30-day bump on pause/admin calls                                   | Restore the instance; the previous pause state is restored from storage.                                                    |
| `MIG_SNAP` | `MigrationSnapshot`       | Target adapter, valuation, and begin-ledger for a live migration         | 29 days, 30-day bump on migration calls                                     | Restore the instance before executing or inspecting migration state.                                                        |
| `MIG_ACT`  | `i128` sentinel (`0`/`1`) | Whether a migration snapshot is live (Rust constant `MIG_ACTIVE`)        | 29 days, 30-day bump on migration calls                                     | Restore the instance; do not begin a second migration while `1` remains present.                                            |
| `LOCKED`   | `bool`                    | Reentrancy guard, present only during a guarded call                     | 29 days, 30-day bump on guarded calls                                       | Restore the instance; stale `true` is unexpected because the guard removes itself on return.                                |
| `INIT`     | `bool`                    | Legacy initialization reentrancy sentinel (Rust constant `INITIALIZING`) | 29 days, 30-day bump policy; normally removed before initialization returns | Restore or clear only as part of recovery; a live deployment should not retain it.                                          |

The permanent configuration and counters are initialized in `init_state()`. `LOCKED` and `INIT` are transient sentinels rather than permanent configuration.

### Persistent keys

| Key                           | Type                   | Purpose                                        | Bump threshold                                         | Recovery if archived                                                                                                                                                                                               |
| ----------------------------- | ---------------------- | ---------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DataKey::Entry(Address)`     | `u32` ledger sequence  | Original position entry time                   | 113 days, 120-day bump; `extend_position_ttl(address)` | Restore that address's two position footprints before holder reads or operations. If restoration is no longer available, the missing entry looks like a first deposit on its next write.                           |
| `DataKey::Principal(Address)` | `i128` USDC cost basis | Untaxed position principal for fee calculation | 113 days, 120-day bump; `extend_position_ttl(address)` | Restore that address's position footprints. If unavailable, principal reads as `0`, so performance-fee basis may be wrong until a correct off-chain reconstruction is restored or a fresh position is established. |

`extend_position_ttl(address)` is permissionless and bumps both vault instance state and both live position entries for the supplied address. It is suitable for a keeper or for a user to renew an active position. It cannot manufacture an already archived entry; archived footprints must be restored first.

### Archival-looking position behavior

If the position entries for an address are missing, a first deposit may create `Entry(address)` again and `Principal(address)` can read as zero. The mUSDC share balance is owned by the token, not these vault entries, so missing vault history must not be used to infer that a holder has no shares. Restore the footprints before fee or yield calculations; otherwise any reconstruction requires an audited off-chain snapshot and an explicit state-recovery process.

## mUSDC token

Owner: [`musdc-token`](https://github.com/drydocs/meridian/tree/main/packages/contracts/musdc-token). This crate has no explicit TTL bump in its state-changing methods.

### mUSDC instance keys

| Key         | Type      | Purpose                            | Bump threshold                              | Recovery if archived                                                                   |
| ----------- | --------- | ---------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ADMIN`     | `Address` | Vault with mint and burn authority | None in contract code; host/Soroban default | Restore the contract instance; do not call legacy `initialize()` on a live deployment. |
| `DECIMALS`  | `u32`     | SEP-41 decimal precision           | None in contract code; host/Soroban default | Restore the instance; a missing read has a default only for `decimals()` (7).          |
| `NAME`      | `String`  | Token name                         | None in contract code; host/Soroban default | Restore the instance; missing storage falls back to an empty name.                     |
| `SYMBOL`    | `String`  | Token symbol                       | None in contract code; host/Soroban default | Restore the instance; missing storage falls back to an empty symbol.                   |
| `TOTAL_SUP` | `i128`    | Total mUSDC supply                 | None in contract code; host/Soroban default | Restore the instance; missing storage reads as zero.                                   |

### Persistent and temporary keys

| Key                                 | Storage    | Type                                       | Purpose                   | Bump/expiry threshold                                                    | Recovery if archived or expired                                                                                                       |
| ----------------------------------- | ---------- | ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DataKey::Balance(Address)`         | Persistent | `i128`                                     | Holder mUSDC balance      | None in contract code; host/Soroban default persistent TTL               | Restore the balance footprint. A missing balance reads as zero and must not be interpreted as a valid burnable supply until restored. |
| `DataKey::Allowance(from, spender)` | Temporary  | `{ amount: i128, expiration_ledger: u32 }` | SEP-41 transfer allowance | Ledger expiration is checked on every read; no explicit storage TTL bump | A missing or expired allowance reads as zero. Callers must approve again if the intended allowance is still needed.                   |

The mUSDC transfer and burn paths write persistent balances but do not explicitly extend balance TTLs. They also do not extend contract instance TTL. The lack of an application bump is a risk to monitor for idle-token archival, separate from persistent-balance archival.

## Adapters

All adapters inherit `VAULT_KEY` and `USDC_KEY` from `adapter-common`. Adapter state-changing entry points call `extend_instance()` and use a 29-day threshold with a 30-day bump.

| Owner crate / key                                                | Storage  | Type                  | Purpose                                   | Bump threshold       | Recovery if archived                                                               |
| ---------------------------------------------------------------- | -------- | --------------------- | ----------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `VAULT` (`adapter-common` crate, constant `VAULT_KEY`)           | Instance | `Address`             | Vault authorized to call this adapter     | 29 days, 30-day bump | Restore the adapter instance; reinitialize only for a legacy deployment.           |
| `USDC` (`adapter-common` crate, constant `USDC_KEY`)             | Instance | `Address`             | USDC token used by the adapter            | 29 days, 30-day bump | Restore the adapter instance before deposit or withdrawal.                         |
| `POOL` (`blend-adapter` crate, constant `POOL_KEY`)              | Instance | `Address`             | Blend pool contract                       | 29 days, 30-day bump | Restore the adapter instance before protocol calls.                                |
| `TOTAL` (`blend-adapter` crate, constant `TOTAL_KEY`)            | Instance | `i128`                | Cached adapter total/principal accounting | 29 days, 30-day bump | Restore the instance, then reconcile by `accrue()` or the next deposit/withdrawal. |
| `LAST_ACCR` (`blend-adapter` crate, constant `LAST_ACCRUAL_KEY`) | Instance | `u32` ledger sequence | Last Blend accrual refresh                | 29 days, 30-day bump | Restore the instance; `accrue()` can establish a fresh ledger stamp.               |
| `DFXVAULT` (`defindex-adapter` crate, constant `DFX_VAULT`)      | Instance | `Address`             | Target DeFindex vault                     | 29 days, 30-day bump | Restore the adapter instance before protocol calls.                                |

No production persistent or temporary keys are declared by the two adapter crates. Protocol positions can also exist in the external Blend pool or DeFindex vault, but those external protocol ledgers are outside the Meridian contract storage tables above.

## Archival restoration and audit

1. Restore the archived contract instance or persistent/temporary footprint through the wallet, Stellar CLI, or SDK restoration flow before normal contract operations.
2. Confirm the restored key set and the live ledger sequence. Instance restoration restores all keys associated with that contract instance together.
3. For vault positions, call `extend_position_ttl(address)` after restoration to renew the live `Entry` and `Principal` entries.
4. Reconcile adapter counters and external positions from live protocol reads; do not mint or burn shares merely to replace a missing storage read.
5. If a footprint cannot be restored, treat the data as unavailable. Preserve the ledger evidence and use an audited recovery procedure rather than guessing the missing balance or cost basis.

Adding a storage key requires:

- Naming the key and storage class (`instance`, `persistent`, or `temporary`) in this page.
- Selecting and documenting a threshold/bump policy.
- Bumping instance TTL on state-changing entry points that must keep the contract live.
- Bumping persistent position data whenever that position is read or written.
- Adding a TTL audit test that advances the ledger past the threshold and asserts that the key survives.

Current TTL regression coverage includes the vault's position audit and instance/admin audit, adapter deposit/withdraw/accrue audits, shared adapter-key coverage, and storage tests in each contract crate. Search for `storage_ttl_audit` and `*_extends_instance_ttl` when changing or adding keys.
