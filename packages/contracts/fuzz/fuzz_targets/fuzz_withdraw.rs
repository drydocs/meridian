#![no_main]
//! Fuzz target for `MeridianVault::withdraw`.
//!
//! Invariant: any error is a typed `ContractError`; no untyped panic or
//! host trap is reachable from arbitrary `(caller, shares, min_usdc_out)`.

mod common;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Address;

fuzz_target!(|input: common::FuzzInput| {
    let (env, _admin, vault_id) = common::fresh_env();
    env.ledger().set_sequence_number(input.ledger_seq);
    let client = common::client(&env, &vault_id);
    let caller = Address::generate(&env);

    let _ = client.try_withdraw(&caller, &input.amount, &input.min_out);
});
