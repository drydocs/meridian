//! Several depositors sharing one adapter position.

use crate::common::{rate_with_yield_bps, usdc, Fixture};
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn late_depositor_is_priced_at_the_accrued_share_value() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));

    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(1_000)); // Alice's 100 is now 110
    let bob_shares = f.deposit(&bob, usdc(110));

    // Bob pays 110 for what is now 110 of value, so he must receive about as
    // many shares as Alice's 100, not 110. The virtual offset prices the
    // first stroops at 1:1, which shifts the result by ~90 stroops here.
    assert!(
        (bob_shares - usdc(100)).abs() <= 1_000,
        "bob got {bob_shares} shares"
    );
    assert_eq!(f.vault.get_total_shares(), usdc(100) + bob_shares);
    assert_eq!(f.vault.get_principal(&bob), usdc(110));
}

#[test]
fn depositors_split_proceeds_by_their_own_basis() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));

    f.deposit(&alice, usdc(100));
    f.simulate_yield(rate_with_yield_bps(1_000));
    let bob_shares = f.deposit(&bob, usdc(110));

    let alice_out = f.withdraw(&alice, usdc(100));
    let bob_out = f.withdraw(&bob, bob_shares);

    // Alice earned the 10 of yield and pays the fee on it: ~109.
    assert!(
        (alice_out - usdc(109)).abs() <= 1_000,
        "alice got {alice_out}"
    );
    // Bob bought in after the yield, so he has no gain and pays no fee: he
    // gets back ~his 110 (within the vault's virtual-offset rounding).
    assert!((bob_out - usdc(110)).abs() <= 1_000, "bob got {bob_out}");
    assert!(f.musdc_balance(&f.treasury) > 0);

    // Everything left in the system belongs to the treasury's fee shares.
    assert_eq!(f.musdc_balance(&f.vault.address), 0);
    assert_eq!(f.usdc_balance(&f.vault.address), 0);
    assert_eq!(
        f.vault.get_total_shares(),
        f.musdc_balance(&f.treasury),
        "only the treasury should still hold shares"
    );
}

#[test]
fn one_users_exit_does_not_disturb_another_users_position() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));
    f.deposit(&alice, usdc(100));
    f.set_time(crate::common::START_TIME + 3_000);
    f.deposit(&bob, usdc(200));

    f.withdraw(&alice, usdc(100));

    assert_eq!(f.musdc_balance(&bob), usdc(200));
    assert_eq!(f.vault.get_principal(&bob), usdc(200));
    assert_eq!(
        f.vault.get_entry_time(&bob),
        crate::common::START_TIME + 3_000
    );
    assert_eq!(f.vault.get_total_shares(), usdc(200));
    assert_eq!(f.venue.pool.collateral(), usdc(200));
    // Bob can still exit in full.
    assert_eq!(f.withdraw(&bob, usdc(200)), usdc(200));
}

#[test]
fn deposit_transfer_yield_and_exit_across_three_users() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    let carol = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));

    f.deposit(&alice, usdc(100));
    f.deposit(&bob, usdc(100));
    f.transfer(&alice, &carol, usdc(40));
    f.simulate_yield(rate_with_yield_bps(500)); // +5%

    let alice_out = f.withdraw(&alice, usdc(60));
    let bob_out = f.withdraw(&bob, usdc(100));
    let carol_out = f.withdraw(&carol, usdc(40));

    // Equal-sized slices with equal basis and equal yield pay out alike,
    // whether the shares were deposited (Bob) or received (Carol).
    // Alice 60 and Carol 40 are slices of one 100 deposit, so together they
    // match Bob's 100.
    let diff = (alice_out + carol_out - bob_out).abs();
    assert!(
        diff <= 1_000,
        "alice+carol={}, bob={bob_out}",
        alice_out + carol_out
    );
    // Every holder came out ahead of cost.
    assert!(alice_out > usdc(60) && carol_out > usdc(40) && bob_out > usdc(100));
}
