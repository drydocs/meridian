//! The mUSDC transfer callback: `musdc.transfer` -> `vault.on_transfer`
//! splitting cost basis and entry time between sender and receiver.

use crate::common::{usdc, Fixture, START_TIME};
use soroban_sdk::{
    testutils::{Address as _, MockAuthInvoke},
    Address, IntoVal,
};

fn report_benchmark(env: &soroban_sdk::Env, name: &str) {
    let estimate = env.cost_estimate();
    let resources = estimate.resources();
    let memory_bytes = estimate.budget().memory_bytes_cost();
    let fee_stroops = estimate.fee().total;
    println!(
        "SOROBAN_BENCHMARK|{}|{}|{}|{}",
        name, resources.instructions, memory_bytes, fee_stroops
    );
}

/// Alice deposits 100 at `START_TIME`, Bob deposits 50 at `START_TIME + 1_000`.
fn alice_and_bob(f: &Fixture) -> (Address, Address) {
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.set_time(START_TIME + 1_000);
    f.deposit(&bob, usdc(50));
    (alice, bob)
}

#[test]
fn partial_transfer_to_a_holder_splits_basis_and_weights_entry_time() {
    let f = Fixture::new();
    let (alice, bob) = alice_and_bob(&f);

    f.transfer(&alice, &bob, usdc(40));

    // Balances moved on the real token.
    assert_eq!(f.musdc_balance(&alice), usdc(60));
    assert_eq!(f.musdc_balance(&bob), usdc(90));

    // Sender: 40% of the 100 basis moved with the shares; entry time is
    // untouched, exactly like a partial withdraw.
    assert_eq!(f.vault.get_principal(&alice), usdc(60));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME);

    // Receiver: basis adds up, and entry time is principal-weighted:
    // (bob 1_001_000 * 50 + alice 1_000_000 * 40) / 90 = 1_000_555.
    assert_eq!(f.vault.get_principal(&bob), usdc(90));
    assert_eq!(f.vault.get_entry_time(&bob), 1_000_555);

    // A transfer moves ownership only: supply and vault assets are unchanged.
    assert_eq!(f.vault.get_total_shares(), usdc(150));
    assert_eq!(f.musdc_admin().total_supply(), usdc(150));
    assert_eq!(f.vault.get_total_assets(), usdc(150));
}

#[test]
fn transfer_to_a_fresh_address_hands_over_basis_and_entry_time() {
    let f = Fixture::new();
    let (alice, _bob) = alice_and_bob(&f);
    let carol = Address::generate(&f.env);
    f.set_time(START_TIME + 7_000);

    f.transfer(&alice, &carol, usdc(25));

    // Carol never deposited, but inherits a pro-rata slice of Alice's history.
    assert_eq!(f.vault.get_position(&carol), usdc(25));
    assert_eq!(f.vault.get_principal(&carol), usdc(25));
    assert_eq!(f.vault.get_entry_time(&carol), START_TIME);
    assert_eq!(f.vault.get_principal(&alice), usdc(75));
}

#[test]
fn full_transfer_out_clears_the_senders_records() {
    let f = Fixture::new();
    let (alice, bob) = alice_and_bob(&f);

    f.transfer(&alice, &bob, usdc(100));

    assert_eq!(f.musdc_balance(&alice), 0);
    assert_eq!(f.vault.get_principal(&alice), 0);
    assert_eq!(f.vault.get_entry_time(&alice), 0);
    assert_eq!(f.vault.get_principal(&bob), usdc(150));
}

#[test]
fn a_full_transfer_out_then_redeposit_does_not_inherit_a_stale_basis() {
    let f = Fixture::new();
    let (alice, bob) = alice_and_bob(&f);
    f.transfer(&alice, &bob, usdc(100));

    f.set_time(START_TIME + 50_000);
    f.deposit(&alice, usdc(10));

    assert_eq!(f.vault.get_principal(&alice), usdc(10));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME + 50_000);
}

#[test]
fn self_transfer_is_a_no_op_that_skips_the_callback() {
    let f = Fixture::new();
    let (alice, _bob) = alice_and_bob(&f);

    f.transfer(&alice, &alice, usdc(10));

    assert_eq!(f.musdc_balance(&alice), usdc(100));
    assert_eq!(f.vault.get_principal(&alice), usdc(100));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME);
}

#[test]
fn transfer_from_with_an_allowance_also_fires_the_callback() {
    let f = Fixture::new();
    let (alice, bob) = alice_and_bob(&f);
    let spender = Address::generate(&f.env);
    let expiration = f.env.ledger().sequence() + 100;

    f.authorize(
        &alice,
        &f.musdc,
        "approve",
        (alice.clone(), spender.clone(), usdc(30), expiration),
        &[],
    );
    f.musdc_token()
        .approve(&alice, &spender, &usdc(30), &expiration);

    f.authorize(
        &spender,
        &f.musdc,
        "transfer_from",
        (spender.clone(), alice.clone(), bob.clone(), usdc(30)),
        &[],
    );
    f.musdc_token()
        .transfer_from(&spender, &alice, &bob, &usdc(30));

    assert_eq!(f.musdc_balance(&alice), usdc(70));
    assert_eq!(f.musdc_balance(&bob), usdc(80));
    assert_eq!(f.vault.get_principal(&alice), usdc(70));
    assert_eq!(f.vault.get_principal(&bob), usdc(80));
}

#[test]
fn a_transferred_position_withdraws_normally_for_the_receiver() {
    let f = Fixture::new();
    let (alice, _bob) = alice_and_bob(&f);
    let carol = Address::generate(&f.env);
    f.transfer(&alice, &carol, usdc(100));

    // Carol holds shares she never deposited for; she can still exit in full,
    // and her inherited basis is retired with them.
    let out = f.withdraw(&carol, usdc(100));

    assert_eq!(out, usdc(100));
    assert_eq!(f.usdc_balance(&carol), usdc(100));
    assert_eq!(f.vault.get_principal(&carol), 0);
    assert_eq!(f.vault.get_total_shares(), usdc(50));
}

#[test]
fn transfer_needs_only_the_senders_signature() {
    let f = Fixture::new();
    let (alice, bob) = alice_and_bob(&f);

    // The authorized tree has a single root entry and no sub-invocations: the
    // vault callback must be satisfied by mUSDC being its direct caller.
    f.authorize(
        &alice,
        &f.musdc,
        "transfer",
        (alice.clone(), bob.clone(), usdc(1)),
        &[],
    );
    f.musdc_token().transfer(&alice, &bob, &usdc(1));
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, alice);
}

#[test]
fn a_transfer_the_sender_did_not_authorize_is_rejected() {
    let f = Fixture::new();
    let (alice, bob) = alice_and_bob(&f);
    let mallory = Address::generate(&f.env);

    // Mallory signs, but the transfer is from Alice.
    f.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &mallory,
        invoke: &MockAuthInvoke {
            contract: &f.musdc,
            fn_name: "transfer",
            args: (alice.clone(), bob.clone(), usdc(10)).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .musdc_token()
        .try_transfer(&alice, &bob, &usdc(10))
        .is_err());

    assert_eq!(f.musdc_balance(&alice), usdc(100));
    assert_eq!(f.vault.get_principal(&alice), usdc(100));
}

#[test]
fn benchmark_vault_transfer_uses_real_token_and_vault() {
    let f = Fixture::new();
    let sender = Address::generate(&f.env);
    let recipient = Address::generate(&f.env);
    f.fund(&sender, usdc(100));
    f.deposit(&sender, usdc(100));
    f.transfer(&sender, &recipient, usdc(50));
    report_benchmark(&f.env, "vault.transfer");
}
