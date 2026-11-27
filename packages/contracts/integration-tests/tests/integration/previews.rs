//! End-to-end integration tests for read-only deposit and withdrawal previews
//! through the real vault -> adapter -> pool stack.

use crate::common::{rate_with_yield_bps, usdc, Fixture};
use meridian_vault::{ContractError, WithdrawPreview};
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn preview_deposit_matches_executed_deposit_at_initial_state() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));

    let deposit_amount = usdc(100);

    // Initial preview on empty vault prices 1:1
    let quoted_shares = f.vault.preview_deposit(&deposit_amount);
    assert_eq!(quoted_shares, deposit_amount);

    // Executed deposit matches preview exactly
    let minted_shares = f.deposit(&alice, deposit_amount);
    assert_eq!(minted_shares, quoted_shares);
    assert_eq!(f.musdc_balance(&alice), quoted_shares);
}

#[test]
fn preview_deposit_matches_executed_deposit_after_yield_accrual() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    let bob = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.fund(&bob, usdc(1_000));

    f.deposit(&alice, usdc(100));

    // Yield accrues in pool (+10%)
    f.simulate_yield(rate_with_yield_bps(1_000));

    let bob_deposit_amount = usdc(50);

    // Preview deposit refreshes the adapter and quotes the most the deposit can mint
    let quoted_shares = f.vault.preview_deposit(&bob_deposit_amount);

    // The executed mint is priced from the adapter's credit and capped at the
    // quote, so it can fall short of the quote by one stroop of rounding
    let minted_shares = f.deposit(&bob, bob_deposit_amount);
    assert!(minted_shares <= quoted_shares);
    assert!(quoted_shares - minted_shares <= 1);
    assert_eq!(f.musdc_balance(&bob), minted_shares);
}

#[test]
fn preview_withdraw_matches_executed_withdraw_with_performance_fee() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));

    // Simulate yield (+10% gain)
    f.simulate_yield(rate_with_yield_bps(1_000));

    let withdraw_shares = usdc(50);

    // Preview withdrawal for Alice
    let preview: WithdrawPreview = f.vault.preview_withdraw(&alice, &withdraw_shares);

    assert!(preview.gross_assets > 0);
    assert!(preview.fee > 0);
    assert!(preview.treasury_shares > 0);
    assert_eq!(preview.assets_out, preview.gross_assets - preview.fee);

    let treasury_musdc_before = f.musdc_balance(&f.treasury);

    // Execute actual withdrawal
    let actual_out = f.withdraw(&alice, withdraw_shares);
    assert_eq!(actual_out, preview.assets_out);

    let treasury_musdc_after = f.musdc_balance(&f.treasury);
    assert_eq!(
        treasury_musdc_after - treasury_musdc_before,
        preview.treasury_shares
    );
}

#[test]
fn preview_withdraw_matches_executed_withdraw_without_yield() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));

    // No yield: fee and treasury shares must be 0
    let preview: WithdrawPreview = f.vault.preview_withdraw(&alice, &usdc(100));
    assert_eq!(preview.fee, 0);
    assert_eq!(preview.treasury_shares, 0);
    assert_eq!(preview.gross_assets, usdc(100));
    assert_eq!(preview.assets_out, usdc(100));

    let actual_out = f.withdraw(&alice, usdc(100));
    assert_eq!(actual_out, preview.assets_out);
}

#[test]
fn preview_deposit_and_withdraw_return_typed_errors_on_edge_cases() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));

    // Empty vault withdraw
    let res = f.vault.try_preview_withdraw(&alice, &usdc(10));
    assert_eq!(res, Err(Ok(ContractError::NoSharesOutstanding)));

    // Negative deposit
    let res_neg = f.vault.try_preview_deposit(&-1);
    assert_eq!(res_neg, Err(Ok(ContractError::ZeroAmount)));

    // Zero deposit quotes 0
    assert_eq!(f.vault.preview_deposit(&0), 0);

    // Zero withdraw quotes 0
    let zero_preview = f.vault.preview_withdraw(&alice, &0);
    assert_eq!(
        zero_preview,
        WithdrawPreview {
            gross_assets: 0,
            fee: 0,
            treasury_shares: 0,
            assets_out: 0,
            available_liquidity: 0,
        }
    );

    // Deposits paused
    f.authorize(&f.admin, &f.vault.address, "set_paused", (true,), &[]);
    f.vault.set_paused(&true);
    let paused_res = f.vault.try_preview_deposit(&usdc(10));
    assert_eq!(paused_res, Err(Ok(ContractError::DepositsPaused)));
}

#[test]
fn preview_calls_do_not_mutate_state_or_balances() {
    let f = Fixture::new();
    let alice = Address::generate(&f.env);
    f.fund(&alice, usdc(1_000));
    f.deposit(&alice, usdc(100));

    let usdc_balance_before = f.usdc_balance(&alice);
    let musdc_balance_before = f.musdc_balance(&alice);
    let total_shares_before = f.vault.get_total_shares();
    let pool_collateral_before = f.venue.pool.collateral();

    // Call previews multiple times
    let _ = f.vault.preview_deposit(&usdc(50));
    let _ = f.vault.preview_withdraw(&alice, &usdc(50));

    // Assert strictly immutable state
    assert_eq!(f.usdc_balance(&alice), usdc_balance_before);
    assert_eq!(f.musdc_balance(&alice), musdc_balance_before);
    assert_eq!(f.vault.get_total_shares(), total_shares_before);
    assert_eq!(f.venue.pool.collateral(), pool_collateral_before);
}
