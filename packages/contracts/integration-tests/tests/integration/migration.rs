//! Adapter migration through the full `begin_migration` -> timelock ->
//! `migrate_adapter` flow, against two real adapters on two mock pools.

use crate::common::{rate_with_yield_bps, usdc, Fixture, START_TIME};
use meridian_vault::{ContractError, MIN_LEDGER_GAP};
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn migration_moves_the_whole_position_after_the_full_timelock() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(500)); // 100 -> 105 before the move

    let old = &f.venue;
    let new = f.new_venue();

    // Phase 1: snapshot the target and start the clock.
    f.authorize_admin("begin_migration", (new.adapter.address.clone(),));
    f.vault.begin_migration(&new.adapter.address);
    let snapshot = f.vault.get_migration_snapshot();
    assert_eq!(snapshot.adapter, new.adapter.address);
    assert_eq!(snapshot.total_assets, 0);

    // Immediately and one ledger short of the gap: still locked.
    f.authorize_admin("migrate_adapter", (new.adapter.address.clone(), 50_u32));
    assert_eq!(
        f.vault.try_migrate_adapter(&new.adapter.address, &50),
        Err(Ok(ContractError::MigrationCooldownNotMet))
    );
    f.advance_ledgers(MIN_LEDGER_GAP - 1);
    f.authorize_admin("migrate_adapter", (new.adapter.address.clone(), 50_u32));
    assert_eq!(
        f.vault.try_migrate_adapter(&new.adapter.address, &50),
        Err(Ok(ContractError::MigrationCooldownNotMet))
    );
    assert_eq!(f.vault.get_adapter(), old.adapter.address);

    // At exactly the gap it goes through.
    f.advance_ledgers(1);
    f.authorize_admin("migrate_adapter", (new.adapter.address.clone(), 50_u32));
    f.vault.migrate_adapter(&new.adapter.address, &50);

    // The vault now routes to the new adapter and the old venue is empty.
    assert_eq!(f.vault.get_adapter(), new.adapter.address);
    assert_eq!(old.pool.collateral(), 0);
    assert_eq!(f.usdc_balance(&old.pool.address), 0);
    assert_eq!(f.usdc_balance(&old.adapter.address), 0);

    // All 105 (principal plus yield) landed at the new venue, at par.
    assert_eq!(new.pool.collateral(), usdc(105));
    assert_eq!(f.usdc_balance(&new.pool.address), usdc(105));
    assert_eq!(new.adapter.total_assets(), usdc(105));
    assert_eq!(f.vault.get_total_assets(), usdc(105));
    assert_eq!(f.usdc_balance(&f.vault.address), 0);

    // Holders are untouched: shares, basis and entry time are denominated in
    // mUSDC, not adapter shares.
    assert_eq!(f.musdc_balance(&alice), usdc(100));
    assert_eq!(f.vault.get_total_shares(), usdc(100));
    assert_eq!(f.vault.get_principal(&alice), usdc(100));
    assert_eq!(f.vault.get_entry_time(&alice), START_TIME);
}

#[test]
fn users_deposit_and_withdraw_against_the_new_adapter_after_migrating() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));
    f.deposit(&alice, usdc(100));

    let new = f.new_venue();
    f.authorize_admin("begin_migration", (new.adapter.address.clone(),));
    f.vault.begin_migration(&new.adapter.address);
    f.advance_ledgers(MIN_LEDGER_GAP);
    f.authorize_admin("migrate_adapter", (new.adapter.address.clone(), 0_u32));
    f.vault.migrate_adapter(&new.adapter.address, &0);

    // A new deposit lands on the new adapter, priced at the migrated par.
    let bob_shares = f.deposit_into(&new, &bob, usdc(50));
    assert_eq!(bob_shares, usdc(50));
    assert_eq!(new.pool.collateral(), usdc(150));
    assert_eq!(f.vault.get_total_assets(), usdc(150));

    // Both can exit in full, Alice from a position that began at the old pool.
    assert_eq!(f.withdraw(&alice, usdc(100)), usdc(100));
    assert_eq!(f.withdraw(&bob, usdc(50)), usdc(50));
    assert_eq!(new.pool.collateral(), 0);
}

#[test]
fn migrate_without_a_begin_migration_snapshot_is_rejected() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    let new = f.new_venue();

    f.advance_ledgers(MIN_LEDGER_GAP);
    f.authorize_admin("migrate_adapter", (new.adapter.address.clone(), 0_u32));

    assert_eq!(
        f.vault.try_migrate_adapter(&new.adapter.address, &0),
        Err(Ok(ContractError::MigrationNotInitialized))
    );
}

#[test]
fn a_snapshot_for_one_adapter_cannot_authorize_migrating_to_another() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    let snapshotted = f.new_venue();
    let other = f.new_venue();

    f.authorize_admin("begin_migration", (snapshotted.adapter.address.clone(),));
    f.vault.begin_migration(&snapshotted.adapter.address);
    f.advance_ledgers(MIN_LEDGER_GAP);

    f.authorize_admin("migrate_adapter", (other.adapter.address.clone(), 0_u32));
    assert_eq!(
        f.vault.try_migrate_adapter(&other.adapter.address, &0),
        Err(Ok(ContractError::MigrationNotInitialized))
    );
    assert_eq!(f.vault.get_adapter(), f.venue.adapter.address);
}

#[test]
fn migration_cannot_exceed_the_admin_slippage_ceiling() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    let new = f.new_venue();
    f.authorize_admin("begin_migration", (new.adapter.address.clone(),));
    f.vault.begin_migration(&new.adapter.address);
    f.advance_ledgers(MIN_LEDGER_GAP);

    f.authorize_admin("migrate_adapter", (new.adapter.address.clone(), 501_u32));
    assert_eq!(
        f.vault.try_migrate_adapter(&new.adapter.address, &501),
        Err(Ok(ContractError::InvalidSlippageBps))
    );
}

#[test]
fn only_the_admin_can_begin_or_complete_a_migration() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));
    let new = f.new_venue();

    // Alice signs a begin_migration; the vault wants the admin's signature.
    f.authorize(
        &alice,
        &f.vault.address,
        "begin_migration",
        (new.adapter.address.clone(),),
        &[],
    );
    assert!(f.vault.try_begin_migration(&new.adapter.address).is_err());
    assert!(f.vault.try_get_migration_snapshot().is_err());

    f.authorize(
        &alice,
        &f.vault.address,
        "migrate_adapter",
        (new.adapter.address.clone(), 0_u32),
        &[],
    );
    assert!(f
        .vault
        .try_migrate_adapter(&new.adapter.address, &0)
        .is_err());
    assert_eq!(f.vault.get_adapter(), f.venue.adapter.address);
}
