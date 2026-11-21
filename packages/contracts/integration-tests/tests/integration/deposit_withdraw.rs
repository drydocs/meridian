//! Deposit and withdraw through the real vault -> adapter -> pool stack.

use crate::common::{usdc, Fixture, START_TIME};
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn deposit_flows_through_vault_adapter_and_pool() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));

    let shares = f.deposit(&alice, usdc(100));

    // First deposit prices 1 share = 1 stroop.
    assert_eq!(shares, usdc(100));
    assert_eq!(f.musdc_balance(&alice), usdc(100));
    assert_eq!(f.musdc_admin().total_supply(), usdc(100));
    assert_eq!(f.vault.get_total_shares(), usdc(100));
    assert_eq!(f.vault.get_position(&alice), usdc(100));

    // USDC went from Alice straight to the pool, via the adapter's
    // `authorize_as_current_contract` pre-auth of the pool's nested transfer.
    assert_eq!(f.usdc_balance(&alice), usdc(900));
    assert_eq!(f.usdc_balance(&f.venue.adapter.address), 0);
    assert_eq!(f.usdc_balance(&f.vault.address), 0);
    assert_eq!(f.usdc_balance(&f.venue.pool.address), usdc(100));

    // The pool credits bTokens at par; adapter and vault agree on the value.
    assert_eq!(f.venue.pool.collateral(), usdc(100));
    assert_eq!(f.venue.adapter.total_shares(), usdc(100));
    assert_eq!(f.venue.adapter.total_assets(), usdc(100));
    assert_eq!(f.vault.get_total_assets(), usdc(100));

    // Cost basis and entry time.
    assert_eq!(f.vault.get_principal(&alice), usdc(100));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME);
}

#[test]
fn top_up_deposit_keeps_entry_time_and_accumulates_principal() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));

    f.deposit(&alice, usdc(100));
    f.set_time(START_TIME + 5_000);
    f.deposit(&alice, usdc(50));

    assert_eq!(f.musdc_balance(&alice), usdc(150));
    assert_eq!(f.vault.get_principal(&alice), usdc(150));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME);
}

#[test]
fn full_withdraw_without_yield_returns_principal_and_clears_the_position() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));

    let out = f.withdraw(&alice, usdc(100));

    // No gain, so no performance fee and the whole deposit comes back.
    assert_eq!(out, usdc(100));
    assert_eq!(f.usdc_balance(&alice), usdc(1_000));
    assert_eq!(f.musdc_balance(&alice), 0);
    assert_eq!(f.musdc_admin().total_supply(), 0);
    assert_eq!(f.vault.get_total_shares(), 0);
    assert_eq!(f.musdc_balance(&f.treasury), 0);

    // The pool and adapter are drained and agree.
    assert_eq!(f.venue.pool.collateral(), 0);
    assert_eq!(f.usdc_balance(&f.venue.pool.address), 0);
    assert_eq!(f.venue.adapter.total_assets(), 0);
    assert_eq!(f.usdc_balance(&f.vault.address), 0);

    // A full exit clears cost basis and entry time.
    assert_eq!(f.vault.get_principal(&alice), 0);
    assert_eq!(f.vault.get_entry_time(&alice), 0);
}

#[test]
fn partial_withdraw_retires_basis_pro_rata_and_keeps_entry_time() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.set_time(START_TIME + 9_000);

    let out = f.withdraw(&alice, usdc(40));

    assert_eq!(out, usdc(40));
    assert_eq!(f.musdc_balance(&alice), usdc(60));
    assert_eq!(f.vault.get_principal(&alice), usdc(60));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME);
    assert_eq!(f.vault.get_total_shares(), usdc(60));
    assert_eq!(f.venue.pool.collateral(), usdc(60));
    assert_eq!(f.usdc_balance(&f.venue.pool.address), usdc(60));
}

#[test]
fn redeposit_after_a_full_exit_starts_a_fresh_position() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.withdraw(&alice, usdc(100));

    f.set_time(START_TIME + 20_000);
    f.deposit(&alice, usdc(30));

    assert_eq!(f.vault.get_principal(&alice), usdc(30));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME + 20_000);
}

#[test]
fn withdrawing_more_shares_than_held_is_rejected() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.fund(&bob, usdc(100));
    f.deposit(&alice, usdc(100));
    f.deposit(&bob, usdc(100));

    // Alice holds 100 shares of a 200-share vault; asking for 150 must hit the
    // typed InsufficientShares error, not drain Bob's funds.
    f.authorize(
        &alice,
        &f.vault.address,
        "withdraw",
        (alice.clone(), usdc(150), 0_i128),
        &[],
    );
    let res = f.vault.try_withdraw(&alice, &usdc(150), &0_i128);
    assert_eq!(
        res,
        Err(Ok(meridian_vault::ContractError::InsufficientShares))
    );
    assert_eq!(f.musdc_balance(&alice), usdc(100));
    assert_eq!(f.venue.pool.collateral(), usdc(200));
}
