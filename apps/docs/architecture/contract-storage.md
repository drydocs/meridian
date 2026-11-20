# Contract Storage and TTL Reference

This inventory is maintained against the contract source. Test-only fixture
keys are excluded.

## TTL thresholds

`DAY_IN_LEDGERS` is 17,280 ledgers, approximately one day at five seconds per
ledger.

| Storage                   |                Bump |      Refresh threshold | Source                                         |
| ------------------------- | ------------------: | ---------------------: | ---------------------------------------------- |
| Contract instance entries |             30 days |                29 days | `packages/contracts/adapter-common/src/lib.rs` |
| Vault position entries    |            120 days |               113 days | `packages/contracts/vault/src/lib.rs`          |
| mUSDC allowances          | `expiration_ledger` | Read as zero at expiry | `packages/contracts/musdc-token/src/lib.rs`    |

Adapters call `extend_instance` from state-changing entry points. The vault
extends `Entry(address)` and `Principal(address)` through deposits,
withdrawals, transfers, and permissionless `extend_position_ttl(address)`.

## Key inventory

| Contract         | Storage class | Keys and values                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault            | Instance      | `ADMIN`, `PEND_ADM`, `USDC`, `MUSDC`, `ADAPTER`, and `TREASURY` are `Address` values; `TOTAL_SH` and `ADPT_SH` are `i128`; `PAUSED` and `LOCKED` are `bool`; `MIG_SNAP` is `MigrationSnapshot { adapter, total_assets, ledger_seq }`; `MIG_ACT` is an `i128` active sentinel. All use the instance policy. |
| Vault            | Persistent    | `Entry(Address) -> u64` and `Principal(Address) -> i128`; both use the 120-day position policy.                                                                                                                                                                                                            |
| mUSDC            | Instance      | `ADMIN -> Address`, `DECIMALS -> u32`, `NAME -> String`, `SYMBOL -> String`, and `TOTAL_SUP -> i128`; use the instance policy.                                                                                                                                                                             |
| mUSDC            | Persistent    | `Balance(Address) -> i128`; keep the account entry live while the balance exists.                                                                                                                                                                                                                          |
| mUSDC            | Temporary     | `Allowance(Address, Address) -> AllowanceValue { amount: i128, expiration_ledger: u32 }`; re-approve after expiry.                                                                                                                                                                                         |
| Shared adapters  | Instance      | `VAULT` and `USDC`, both `Address`, use the shared instance policy.                                                                                                                                                                                                                                        |
| Blend adapter    | Instance      | `POOL -> Address` and `TOTAL -> i128`, using the shared instance policy. The Blend pool is authoritative for the underlying position.                                                                                                                                                                      |
| DeFindex adapter | Instance      | `DFXVAULT -> Address`, using the shared instance policy. The DeFindex vault is authoritative for the underlying position.                                                                                                                                                                                  |

## Recovery rules

Extend a live entry before its threshold. If a persistent entry is already
archived, use ledger history and the documented migration/reconciliation path;
do not silently recreate cost basis, balances, or adapter shares as zero. An
expired allowance is expected authorization expiry and must be approved again.

The [vault architecture](./vault-contract) page describes the accounting
relationships, and the [mainnet deployment guide](../operations/mainnet-deployment)
lists the operational TTL parameters.
