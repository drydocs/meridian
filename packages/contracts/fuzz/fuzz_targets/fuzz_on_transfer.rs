#![no_main]
//! Fuzz target for `MeridianVault::on_transfer`.
//!
//! Invariant: an unauthenticated / malformed on_transfer callback returns
//! a typed `ContractError` (typically `Unauthorized` or `ReentrancyDetected`)
//! and never aborts the host.

mod common;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Address;

fuzz_target!(|input: common::FuzzInput| {
    let (env, _admin, vault_id) = common::fresh_env();
    env.ledger().set_sequence_number(input.ledger_seq);
    let client = common::client(&env, &vault_id);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let _ = client.try_on_transfer(
        &from,
        &to,
        &input.amount,
        &input.min_out,
        &(input.max_slippage_bps as i128),
    );
});
