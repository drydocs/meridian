# Vault & adapter fuzz targets

A cargo-fuzz workspace that exercises the Meridian vault's user-facing and
admin entry points with arbitrary inputs. Each target asserts the shared
contract:

> **Every failure is a typed `ContractError`; no untyped panic or host trap
> is reachable from arbitrary input.**

A reachable panic or trap is a bug: the vault is immutable once deployed and
holds user funds, so panics that an adversary can trigger from arbitrary RPC
input have the force of a liveness bug.

## Targets

| Target | Entry point |
| --- | --- |
| `fuzz_deposit` | `MeridianVault::deposit` |
| `fuzz_withdraw` | `MeridianVault::withdraw` |
| `fuzz_on_transfer` | `MeridianVault::on_transfer` |
| `fuzz_set_adapter` | `MeridianVault::set_adapter` |
| `fuzz_begin_migration` | `MeridianVault::begin_migration` |
| `fuzz_migrate_adapter` | `MeridianVault::migrate_adapter` |

Each target has a seeded corpus under `corpus/<target>/`, committed so a
regression bucket is restored on every run.

## Running locally

Requires `cargo-fuzz` and a nightly toolchain:

```sh
rustup toolchain install nightly
cargo install cargo-fuzz

# From packages/contracts, runs `fuzz_deposit` with a bounded budget.
cargo +nightly fuzz run fuzz_deposit -- -runs=50000 -max_total_time=60

# Reproduce a crash the nightly CI uploaded as an artifact.
cargo +nightly fuzz run fuzz_deposit crash-<hash>
```

A longer local soak (e.g. 10 minutes per target) is recommended before
auditing a release branch:

```sh
for target in fuzz_deposit fuzz_withdraw fuzz_on_transfer \
              fuzz_set_adapter fuzz_begin_migration fuzz_migrate_adapter; do
  cargo +nightly fuzz run "$target" -- -max_total_time=600 || break
done
```

## CI

A nightly GitHub Actions workflow (`.github/workflows/contracts-fuzz.yml`)
runs a bounded session for each target and uploads any crash under
`artifacts/` for triage.
