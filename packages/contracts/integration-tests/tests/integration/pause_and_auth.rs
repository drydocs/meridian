//! Pause semantics and the cross-contract authorization boundaries between
//! the real vault, mUSDC and adapter.

use crate::common::{usdc, Fixture};
use meridian_vault::ContractError;
use soroban_sdk::{
    testutils::{Address as _, MockAuthInvoke},
    Address, IntoVal,
};

#[test]
fn pause_blocks_deposits_but_never_withdrawals_or_transfers() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));
    f.deposit(&alice, usdc(100));

    f.authorize_admin("set_paused", (true,));
    f.vault.set_paused(&true);
    assert!(f.vault.is_paused());

    // New deposits are refused with the typed error.
    f.authorize(
        &bob,
        &f.vault.address,
        "deposit",
        (bob.clone(), usdc(10), 0_i128),
        &[MockAuthInvoke {
            contract: &f.usdc,
            fn_name: "transfer",
            args: (bob.clone(), f.venue.adapter.address.clone(), usdc(10)).into_val(&f.env),
            sub_invokes: &[],
        }],
    );
    assert_eq!(
        f.vault.try_deposit(&bob, &usdc(10), &0),
        Err(Ok(ContractError::DepositsPaused))
    );
    assert_eq!(f.usdc_balance(&bob), usdc(1_000));

    // mUSDC transfers (and the vault callback) still work while paused...
    f.transfer(&alice, &bob, usdc(30));
    assert_eq!(f.vault.get_principal(&bob), usdc(30));

    // ...and so does exiting: a pause can never trap funds.
    assert_eq!(f.withdraw(&alice, usdc(70)), usdc(70));
    assert_eq!(f.withdraw(&bob, usdc(30)), usdc(30));
}

#[test]
fn unpausing_reopens_deposits() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));

    f.authorize_admin("set_paused", (true,));
    f.vault.set_paused(&true);
    f.authorize_admin("set_paused", (false,));
    f.vault.set_paused(&false);

    assert!(!f.vault.is_paused());
    assert_eq!(f.deposit(&alice, usdc(100)), usdc(100));
}

#[test]
fn only_the_admin_can_pause() {
    let f = Fixture::new();
    let mallory = Address::generate(&f.env);

    f.authorize(&mallory, &f.vault.address, "set_paused", (true,), &[]);
    assert!(f.vault.try_set_paused(&true).is_err());
    assert!(!f.vault.is_paused());
}

#[test]
fn a_deposit_without_the_callers_signature_is_rejected() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));

    // `Fixture::new` leaves the environment enforcing: no signature, no deposit.
    assert!(f.vault.try_deposit(&alice, &usdc(100), &0).is_err());
    assert_eq!(f.usdc_balance(&alice), usdc(100));
    assert_eq!(f.vault.get_total_shares(), 0);
}

#[test]
fn a_deposit_that_omits_the_usdc_transfer_authorization_is_rejected() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(100));

    // Alice authorizes `vault.deposit` but not the USDC pull beneath it, which
    // is a separate node in the real authorization tree.
    f.authorize(
        &alice,
        &f.vault.address,
        "deposit",
        (alice.clone(), usdc(100), 0_i128),
        &[],
    );
    assert!(f.vault.try_deposit(&alice, &usdc(100), &0).is_err());
    assert_eq!(f.usdc_balance(&alice), usdc(100));
    assert_eq!(f.venue.pool.collateral(), 0);
}

#[test]
fn only_the_vault_can_mint_musdc() {
    let f = Fixture::new();
    let mallory = Address::generate(&f.env);

    // The token's admin is, structurally, the vault contract.
    assert_eq!(f.musdc_admin().admin(), f.vault.address);

    f.authorize(
        &mallory,
        &f.musdc,
        "mint",
        (mallory.clone(), usdc(1_000_000)),
        &[],
    );
    assert!(f
        .musdc_admin()
        .try_mint(&mallory, &usdc(1_000_000))
        .is_err());
    assert_eq!(f.musdc_balance(&mallory), 0);
    assert_eq!(f.musdc_admin().total_supply(), 0);
}

#[test]
fn only_musdc_can_invoke_the_vault_transfer_callback() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let mallory = Address::generate(&f.env);
    f.fund(&alice, usdc(100));
    f.deposit(&alice, usdc(100));

    // Mallory calls `on_transfer` directly to try to move Alice's cost basis
    // to herself without any real transfer. mUSDC did not call, so its
    // authorization is absent.
    f.authorize(
        &mallory,
        &f.vault.address,
        "on_transfer",
        (alice.clone(), mallory.clone(), usdc(100), usdc(100), 0_i128),
        &[],
    );
    assert!(f
        .vault
        .try_on_transfer(&alice, &mallory, &usdc(100), &usdc(100), &0)
        .is_err());
    assert_eq!(f.vault.get_principal(&alice), usdc(100));
    assert_eq!(f.vault.get_principal(&mallory), 0);
}

#[test]
fn only_the_vault_can_drive_the_adapter() {
    let f = Fixture::new();
    let mallory = Address::generate(&f.env);
    f.fund(&mallory, usdc(100));

    // Funds sitting on the adapter must not be spendable by anyone but the
    // vault, whose authorization `require_vault_auth` checks.
    f.authorize(
        &mallory,
        &f.venue.adapter.address,
        "withdraw",
        (usdc(1), mallory.clone()),
        &[],
    );
    assert!(f.venue.adapter.try_withdraw(&usdc(1), &mallory).is_err());

    f.authorize(
        &mallory,
        &f.venue.adapter.address,
        "deposit",
        (usdc(1),),
        &[],
    );
    assert!(f.venue.adapter.try_deposit(&usdc(1)).is_err());
}
