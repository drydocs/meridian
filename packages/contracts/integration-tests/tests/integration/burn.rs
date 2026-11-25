//! Holder burns must not leave pricing or adapter maintenance on stale supply.

use crate::common::{usdc, Fixture};
use meridian_vault::{ContractError, MIN_LEDGER_GAP, TOTAL_SH};
use soroban_sdk::{testutils::Address as _, Address};

fn burn(f: &Fixture, holder: &Address, amount: i128) {
    f.authorize(holder, &f.musdc, "burn", (holder.clone(), amount), &[]);
    f.musdc_token().burn(holder, &amount);
}

#[test]
fn direct_burn_updates_totals_quotes_and_next_deposit() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.fund(&bob, usdc(100));
    f.deposit(&alice, usdc(100));
    burn(&f, &alice, usdc(40));

    assert_eq!(f.musdc_admin().total_supply(), usdc(60));
    assert_eq!(f.vault.get_total_shares(), usdc(60));
    assert_eq!(f.vault.get_config().total_shares, usdc(60));
    assert_eq!(f.vault.convert_to_assets(&usdc(60)), usdc(100));
    assert_eq!(
        f.vault.preview_withdraw(&alice, &usdc(60)).gross_assets,
        usdc(100)
    );
    let quote = meridian_vault::pricing::shares_for_assets(usdc(100), usdc(60), usdc(100)).unwrap();
    assert_eq!(f.vault.convert_to_shares(&usdc(100)), quote);
    assert_eq!(f.vault.preview_deposit(&usdc(100)), quote);
    assert_eq!(f.deposit(&bob, usdc(100)), quote);
    assert_eq!(f.vault.get_total_shares(), f.musdc_admin().total_supply());
    assert!(!f.vault.get_health().total_shares_mismatch);
}

#[test]
fn delegated_burn_and_subsequent_withdraw_count_each_burn_once() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let spender = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    f.authorize(
        &alice,
        &f.musdc,
        "approve",
        (alice.clone(), spender.clone(), usdc(40), 2_000_u32),
        &[],
    );
    f.musdc_token().approve(&alice, &spender, &usdc(40), &2_000);
    f.authorize(
        &spender,
        &f.musdc,
        "burn_from",
        (spender.clone(), alice.clone(), usdc(40)),
        &[],
    );
    f.musdc_token().burn_from(&spender, &alice, &usdc(40));
    assert_eq!(f.musdc_token().allowance(&alice, &spender), 0);
    assert_eq!(f.vault.get_total_shares(), usdc(60));
    assert_eq!(f.withdraw(&alice, usdc(60)), usdc(100));
    assert_eq!(f.vault.get_total_shares(), 0);
    assert_eq!(f.musdc_admin().total_supply(), 0);
    assert!(!f.vault.get_health().total_shares_mismatch);
    let next = f.new_venue();
    f.authorize_admin("set_adapter", (next.adapter.address.clone(),));
    f.vault.set_adapter(&next.adapter.address);
    assert_eq!(f.vault.get_adapter(), next.adapter.address);
}

#[test]
fn admin_resync_repairs_historical_cache_without_changing_assets_or_balances() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    burn(&f, &alice, usdc(40));
    assert!(f.vault.get_health().total_shares_mismatch);
    f.env.set_auths(&[]);
    assert!(f.vault.try_sync_total_shares().is_err());
    assert_eq!(f.vault.get_health().total_shares, usdc(100));
    f.authorize_admin("sync_total_shares", ());
    assert_eq!(f.vault.sync_total_shares(), usdc(60));
    assert!(!f.vault.get_health().total_shares_mismatch);
    assert_eq!(f.vault.get_total_assets(), usdc(100));
    assert_eq!(f.musdc_balance(&alice), usdc(60));
    assert_eq!(f.vault.get_principal(&alice), usdc(100));
    f.authorize_admin("sync_total_shares", ());
    assert_eq!(f.vault.sync_total_shares(), usdc(60));
}

#[test]
fn one_stroop_burn_keeps_residual_assets_safe_and_migration_available() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, 1);
    f.deposit(&alice, 1);
    burn(&f, &alice, 1);
    assert_eq!(f.vault.get_total_shares(), 0);
    f.authorize_admin("sync_total_shares", ());
    assert_eq!(f.vault.sync_total_shares(), 0);
    let next = f.new_venue();
    f.authorize_admin("set_adapter", (next.adapter.address.clone(),));
    assert_eq!(
        f.vault.try_set_adapter(&next.adapter.address),
        Err(Ok(ContractError::AdapterSwapUnsafe))
    );
    f.authorize_admin("begin_migration", (next.adapter.address.clone(),));
    f.vault.begin_migration(&next.adapter.address);
    f.advance_ledgers(MIN_LEDGER_GAP);
    f.authorize_admin("migrate_adapter", (next.adapter.address.clone(), 0_u32));
    f.vault.migrate_adapter(&next.adapter.address, &0);
    assert_eq!(f.vault.get_adapter(), next.adapter.address);
    assert_eq!(f.vault.get_total_assets(), 1);
    assert_eq!(f.vault.get_total_shares(), 0);
}

#[test]
fn stale_cache_alone_does_not_block_an_empty_adapter_swap() {
    let f = Fixture::new();
    f.env.as_contract(&f.vault.address, || {
        f.env.storage().instance().set(&TOTAL_SH, &1_i128);
    });
    let next = f.new_venue();
    f.authorize_admin("set_adapter", (next.adapter.address.clone(),));
    f.vault.set_adapter(&next.adapter.address);
    assert_eq!(f.vault.get_adapter(), next.adapter.address);
    assert_eq!(f.vault.get_total_shares(), 0);
}

#[test]
fn failed_supply_read_never_falls_back_to_cached_pricing() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    f.env.as_contract(&f.vault.address, || {
        f.env
            .storage()
            .instance()
            .set(&meridian_vault::MUSDC, &f.usdc);
    });
    assert!(f.vault.try_get_total_shares().is_err());
    assert!(f.vault.try_convert_to_shares(&usdc(1)).is_err());
    f.authorize_admin("sync_total_shares", ());
    assert!(f.vault.try_sync_total_shares().is_err());
    assert_eq!(f.vault.get_health().total_shares, usdc(100));
    assert!(f.vault.get_health().musdc_supply_stale);
}
