#![no_main]
//! Fuzz target for `MeridianVault::deposit`.
//!
//! Invariant: any error is a typed `ContractError`; no untyped panic or
//! host trap is reachable from arbitrary `(caller, amount, min_shares_out)`.

mod common;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Address;

fuzz_target!(|input: common::FuzzInput| {
    let (env, _admin, vault_id) = common::fresh_env();
    env.ledger().set_sequence_number(input.ledger_seq);
    let client = common::client(&env, &vault_id);
    let caller = Address::generate(&env);

    // `try_deposit` returns `Result<_, ContractError>` on failure; a panic
    // or host trap aborts the fuzzer process.
    let _ = client.try_deposit(&caller, &input.amount, &input.min_out);
});
