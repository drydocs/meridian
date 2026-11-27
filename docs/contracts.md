# Contracts

Meridian ships one Soroban contract: a **vault** that holds user USDC and mints
share tokens, protocol-specific work is delegated to a swappable adapter, not
a second contract.

The vault lives under `packages/contracts/vault/` and is built with the
Stellar CLI (`stellar contract build`). The deploy script at
`scripts/deploy-testnet.sh` builds, uploads, and deploys it.

## Vault (`meridian-vault`)

Source: [`packages/contracts/vault/src/lib.rs`](../packages/contracts/vault/src/lib.rs)

The vault is a protocol-agnostic coordinator, not a direct protocol integration:
it holds no opinion about where funds actually earn yield and delegates all
protocol-specific work to a swappable **adapter** contract (`BlendAdapter` or
`DefindexAdapter`), selected via `set_adapter`. Users deposit USDC and receive
mUSDC share tokens whose redemption value grows with yield accrued in the
active adapter's underlying protocol.

There is exactly one vault deployment per supported asset (one for USDC), not
one per protocol. There is no `route_to` or protocol-selection parameter on
`deposit`, which protocol funds reach is determined entirely by whichever
adapter the vault currently has set, not by anything the caller passes in,
and not by which of several vault instances a deposit went to, there's only
one. Moving the vault's exposure from one protocol to another (e.g. Blend to
DeFindex) is `migrate_adapter`, an admin/keeper-triggered operation on the
vault itself: it never touches any individual depositor's mUSDC balance,
since shares are priced against the vault's total value, not reissued per
protocol. See
[`apps/docs/architecture/vault-contract.md`](../apps/docs/architecture/vault-contract.md)
for `migrate_adapter`'s full behavior and its slippage/value-preservation
invariant.

A virtual share/asset offset of 1 000 stroops is applied to all price
calculations to neutralise the first-depositor inflation attack: an attacker
who donates USDC directly to the adapter recovers only a negligible fraction of
the donation, making the skim unprofitable.

A pending migration can be cancelled during its cooldown with `cancel_migration`. The call is admin-only, clears the migration snapshot, emits an admin event and fails with `NoPendingMigration` when nothing is pending. After a cancellation `migrate_adapter` rejects the call until a new `begin_migration` is made, and the cooldown itself is unchanged.

For the full entry-point reference, error codes, and storage layout, see
[`apps/docs/architecture/vault-contract.md`](../apps/docs/architecture/vault-contract.md),
that page is the canonical, detailed reference.

## Contract immutability

Neither the vault nor the adapters expose an
`update_current_contract_wasm` (or any other upgrade) entry point. This is a
deliberate security property, not an omission: **once deployed, no one,
including Meridian, can rewrite the contract logic.** For a savings product,
users must be able to trust the code itself rather than its maintainers, and an
immutable contract is the strongest way to offer that guarantee.

An admin-gated `upgrade()` was considered and rejected. The admin key already
concentrates meaningful authority (`set_adapter`, `migrate_adapter`, pause);
adding code-upgrade power on top of it would compound the exact risk that the
migration keeper's admin-authority analysis flags, in exchange for solving a
problem that working tooling already handles:

- Fixing a bug or shipping a feature means building and deploying a fresh
  contract (`scripts/deploy-testnet.sh`), then pointing configuration at the
  new deployment.
- Moving live positions to the new contract does not require a manual
  withdraw-then-deposit cycle per user: `migrate_adapter` moves the vault's
  entire aggregate position to a new adapter atomically in one
  slippage-bounded transaction.

The cost of immutability is redeployment friction; the benefit is that no key
holder can ever change what deployed user funds are governed by.

## Building and deploying

```bash
# Build the vault (and adapters)
cd packages/contracts
stellar contract build

# Deploy to testnet (requires DEPLOYER env var set to a funded secret key)
bash scripts/deploy-testnet.sh
```

The deploy script prints the deployed contract IDs. Add them to `.env` as
`VAULT_CONTRACT_ID`.

## Soroban resource benchmarks

Contract tests report native Soroban cost estimates for vault deposits,
withdrawals, share transfers, migration setup and execution, pause and admin
operations, and Blend and DeFindex adapter deposits and withdrawals. CI checks
CPU instructions, memory bytes, and estimated fees against
[`packages/contracts/benchmarks/baselines.json`](../packages/contracts/benchmarks/baselines.json)
with a 15% tolerance. The share-transfer baseline measures the real mUSDC
token's transfer and callback path. Adapter and vault paths use local protocol
doubles. These estimates use the Soroban SDK's fee schedule and are regression
indicators, not replacements for transaction simulation against deployed WASM.
CI pins Rust to the compiler version recorded in the baseline and rejects
compiler or SDK version drift.

To refresh the baselines after reviewing a deliberate resource change, run
the tests from `packages/contracts` and then the checker from the repository
root:

```bash
cd packages/contracts
set -o pipefail
cargo test --workspace -- --nocapture 2>&1 | tee benchmark-output.log
cd ../..
pnpm check:contract-benchmarks \
  --input packages/contracts/benchmark-output.log \
  --baseline packages/contracts/benchmarks/baselines.json \
  --output packages/contracts/benchmark-results.json \
  --update
```

The benchmark results JSON and raw test log are uploaded as the
`soroban-resource-benchmarks` CI artifact. Commit the updated baseline JSON
alongside the change that motivated it.
