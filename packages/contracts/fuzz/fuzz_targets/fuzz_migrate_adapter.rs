#![no_main]
//! Fuzz target for `MeridianVault::migrate_adapter`.
//!
//! Invariant: any error is a typed `ContractError`; no host trap reachable
//! from an arbitrary `(new_adapter, max_slippage_bps)` pair.

mod common;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Address;

fuzz_target!(|input: common::FuzzInput| {
    let (env, _admin, vault_id) = common::fresh_env();
    env.ledger().set_sequence_number(input.ledger_seq);
    let client = common::client(&env, &vault_id);
    let new_adapter = Address::generate(&env);
    let _ = client.try_migrate_adapter(&new_adapter, &input.max_slippage_bps);
});
