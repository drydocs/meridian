//! Yield accrual and the performance fee, end to end: pool rate -> adapter
//! accrual -> vault fee maths -> treasury mUSDC mint.

use crate::common::{rate_with_yield_bps, usdc, Fixture};
use meridian_vault::PERFORMANCE_FEE_BPS;
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn yield_accrues_into_total_assets_once_the_adapter_refreshes() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));

    f.simulate_yield(rate_with_yield_bps(1_000)); // +10%

    // `total_assets` is a cache; it moves only when the adapter accrues.
    assert_eq!(f.vault.get_total_assets(), usdc(100));
    f.venue.adapter.accrue();
    assert_eq!(f.vault.get_total_assets(), usdc(110));
    // Yield changes the price of a share, not the number of shares.
    assert_eq!(f.vault.get_total_shares(), usdc(100));
    assert_eq!(f.venue.adapter.total_shares(), usdc(100));
}

#[test]
fn withdrawing_with_yield_charges_the_fee_on_the_gain_only() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(1_000)); // 100 -> 110

    let net = f.withdraw(&alice, usdc(100));

    // Gain = 10, fee = 10% of the gain = 1; Alice keeps principal + 9.
    let gain = usdc(10);
    let fee = gain * PERFORMANCE_FEE_BPS / 10_000;
    assert_eq!(fee, usdc(1));
    assert_eq!(net, usdc(109));
    assert_eq!(f.usdc_balance(&alice), usdc(1_000) + usdc(9));
}

#[test]
fn the_fee_is_minted_to_the_treasury_as_fully_backed_musdc() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(1_000));

    f.withdraw(&alice, usdc(100));

    // Alice exited in full, so the treasury is the only holder: it was minted
    // exactly the fee at the 1:1 full-exit price...
    let fee = usdc(1);
    assert_eq!(f.musdc_balance(&f.treasury), fee);
    assert_eq!(f.vault.get_total_shares(), fee);
    assert_eq!(f.musdc_admin().total_supply(), fee);
    // ...and the fee USDC was re-deposited through the adapter into the pool,
    // so those shares are backed rather than being an uncollateralized mint.
    assert_eq!(f.vault.get_total_assets(), fee);
    assert_eq!(f.usdc_balance(&f.vault.address), 0);
    assert_eq!(f.usdc_balance(&f.venue.pool.address), fee);
    f.venue.adapter.accrue();
    let live_assets = f.vault.get_total_assets();
    assert!((live_assets - fee).abs() <= 1, "fee shares not backed");
}

#[test]
fn a_withdrawal_at_a_loss_charges_no_fee() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(-1_000)); // -10%

    let out = f.withdraw(&alice, usdc(100));

    assert_eq!(out, usdc(90));
    assert_eq!(f.musdc_balance(&f.treasury), 0);
    assert_eq!(f.vault.get_total_shares(), 0);
}

#[test]
fn a_partial_withdrawal_charges_the_fee_on_its_own_slice_only() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(1_000)); // 100 -> 110

    // Half the shares are worth 55 against a 50 basis: gain 5, fee 0.5.
    let net = f.withdraw(&alice, usdc(50));

    assert_eq!(net, usdc(55) - usdc(1) / 2);
    // Only the withdrawn half's basis is retired; the retained shares keep
    // their own basis so their gain can be charged on their own exit.
    assert_eq!(f.vault.get_principal(&alice), usdc(50));
    assert!(f.musdc_balance(&f.treasury) > 0);
}

#[test]
fn a_two_step_exit_charges_the_same_total_fee_as_a_single_exit() {
    // Exiting the whole position at once charges 10% of the full 10 gain.
    let single = Fixture::new();
    let alice = Address::generate(&single.env);
    single.fund(&alice, usdc(1_000));
    single.deposit(&alice, usdc(100));
    single.simulate_yield(rate_with_yield_bps(1_000)); // 100 -> 110
    let single_net = single.withdraw(&alice, usdc(100));
    assert_eq!(single_net, usdc(109));

    // The same position exited in two halves must collect the same fee: the
    // first exit's gain must not be folded into the retained shares' basis.
    let split = Fixture::new();
    let bob = Address::generate(&split.env);
    split.fund(&bob, usdc(1_000));
    split.deposit(&bob, usdc(100));
    split.simulate_yield(rate_with_yield_bps(1_000)); // 100 -> 110
    let first_net = split.withdraw(&bob, usdc(50));
    let second_net = split.withdraw(&bob, usdc(50));

    // Equal up to a stroop or two of adapter/treasury-mint rounding, but the
    // gain on the retained shares is no longer sheltered from the fee.
    let two_step_net = first_net + second_net;
    assert!(
        (two_step_net - single_net).abs() <= 2,
        "two-step exit received {two_step_net}, single exit {single_net}"
    );
    // Only the fee remains in each vault, so matching total assets prove the
    // same total fee was retained rather than deferred into basis.
    assert_eq!(single.vault.get_total_assets(), usdc(1));
    assert!((split.vault.get_total_assets() - usdc(1)).abs() <= 2);
}

#[test]
fn a_transferred_position_carries_its_basis_into_the_fee_maths() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));
    // The mUSDC callback hands Bob half of Alice's cost basis (50)...
    f.transfer(&alice, &bob, usdc(50));
    f.simulate_yield(rate_with_yield_bps(1_000)); // 100 -> 110

    // ...so his 50 shares (worth 55) have a gain of 5 and a fee of 0.5. Had
    // the basis not followed the shares he would be taxed on the full 55.
    let net = f.withdraw(&bob, usdc(50));

    assert_eq!(net, usdc(55) - usdc(1) / 2);
    assert_eq!(f.usdc_balance(&bob), net);
}
