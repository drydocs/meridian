extern crate std;

use super::*;
use proptest::{
    prelude::*,
    test_runner::{Config, RngSeed, TestCaseError, TestRunner},
};
use std::{format, string::String, vec::Vec};

const USERS: usize = 3;
const MAX_STEPS: usize = 32;
const CASES: u32 = 48;
const PROPERTY_SEED: u64 = 0x1267_5eed;
const FUNDING: i128 = 1_000_000_000_000;
const MAX_DEPOSIT: i128 = 100_000_000;

/// The generated sequence covers user actions, yield/loss adapter outcomes,
/// and full adapter migrations. The adapter mock is intentionally
/// proportional and lossless on withdrawal; gain/loss operations model
/// protocol valuation changes by minting/burning its underlying USDC.
#[derive(Clone, Copy, Debug)]
enum Operation {
    Deposit { user: usize, amount: i128 },
    Withdraw { user: usize, percent: u8 },
    Transfer { from: usize, to: usize, percent: u8 },
    AdapterGain { amount: i128 },
    AdapterLoss { percent: u8 },
    Migrate,
}

fn operation_strategy() -> impl Strategy<Value = Operation> {
    prop_oneof![
        (0..USERS, 1_i128..=MAX_DEPOSIT)
            .prop_map(|(user, amount)| { Operation::Deposit { user, amount } }),
        (0..USERS, 1_u8..=100)
            .prop_map(|(user, percent)| { Operation::Withdraw { user, percent } }),
        (0..USERS, 0..USERS, 1_u8..=100)
            .prop_map(|(from, to, percent)| { Operation::Transfer { from, to, percent } }),
        (1_i128..=MAX_DEPOSIT).prop_map(|amount| Operation::AdapterGain { amount }),
        (1_u8..=5).prop_map(|percent| Operation::AdapterLoss { percent }),
        Just(Operation::Migrate),
    ]
}

fn operation_sequence_strategy() -> impl Strategy<Value = Vec<Operation>> {
    prop::collection::vec(operation_strategy(), 1..=MAX_STEPS)
}

/// Checks invariants after every generated operation:
///
/// - total mUSDC supply equals the sum of all modeled user and treasury
///   balances, so share mint/burn/transfer bookkeeping cannot drift;
/// - the vault's adapter-share counter equals the adapter's independently
///   reported protocol-share balance;
/// - the proportional mock's reported assets equal its underlying USDC;
/// - no user or treasury can report negative principal, and a zero-share
///   holder has neither principal nor an entry timestamp.
///   Successful deposits are capped at the pre-deposit virtual-offset quote;
///   gain/loss operations move price in the expected direction, withdrawals
///   follow the principal/fee schedule, and migration preserves user shares
///   and principal.
///
/// These checks assume the only mUSDC holders are the generated users and
/// treasury and that adapter-side gains/losses are represented by underlying
/// USDC balance changes. They test vault accounting, not protocol behavior.
fn check_accounting_invariants(
    env: &Env,
    vault: &MeridianVaultClient<'_>,
    users: &[Address],
    treasury: &Address,
    usdc: &Address,
    musdc: &Address,
    adapter: &Address,
) -> Result<(), String> {
    let token = MockMusdcClient::new(env, musdc);
    let mut summed_supply = token.balance(treasury);
    for user in users {
        summed_supply += token.balance(user);
    }

    let total_shares = vault.get_total_shares();
    if summed_supply != total_shares {
        return Err(format!(
            "mUSDC supply mismatch: holder balances {summed_supply}, vault supply {total_shares}"
        ));
    }

    let stored_adapter_shares = env.as_contract(&vault.address, || {
        env.storage()
            .instance()
            .get::<_, i128>(&ADPT_SH)
            .unwrap_or(0)
    });
    let adapter_client = MockAdapterClient::new(env, adapter);
    let actual_adapter_shares = adapter_client.total_shares();
    if stored_adapter_shares != actual_adapter_shares {
        return Err(format!(
            "adapter-share mismatch: vault counter {stored_adapter_shares}, adapter reports {actual_adapter_shares}"
        ));
    }

    let adapter_assets = adapter_client.total_assets();
    let underlying_balance = TokenClient::new(env, usdc).balance(adapter);
    if adapter_assets != underlying_balance {
        return Err(format!(
            "adapter-asset mismatch: adapter reports {adapter_assets}, underlying balance {underlying_balance}"
        ));
    }

    for holder in users.iter().chain(std::iter::once(treasury)) {
        let balance = token.balance(holder);
        let principal = vault.get_principal(holder);
        if principal < 0 {
            return Err(format!(
                "negative principal for holder {holder:?}: {principal}"
            ));
        }
        if balance == 0 && (principal != 0 || vault.get_entry_time(holder) != 0) {
            return Err(format!(
                "position records remain after holder {holder:?} has no shares"
            ));
        }
    }

    if total_shares < 0 || adapter_assets < 0 || stored_adapter_shares < 0 {
        return Err("negative aggregate supply, assets, or adapter shares".into());
    }

    // The virtual offset keeps both sides of the share-price fraction positive,
    // including before the first deposit and after a full exit.
    if total_shares + OFFSET <= 0 || adapter_assets + OFFSET <= 0 {
        return Err("virtual-offset share-price denominator is not positive".into());
    }

    Ok(())
}

fn total_user_principal(vault: &MeridianVaultClient<'_>, users: &[Address]) -> i128 {
    users.iter().map(|user| vault.get_principal(user)).sum()
}

fn share_price_did_not_decrease(
    assets_before: i128,
    shares_before: i128,
    assets_after: i128,
    shares_after: i128,
) -> bool {
    let old_assets = assets_before + OFFSET;
    let old_shares = shares_before + OFFSET;
    let new_assets = assets_after + OFFSET;
    let new_shares = shares_after + OFFSET;

    new_assets
        .checked_mul(old_shares)
        .zip(old_assets.checked_mul(new_shares))
        .is_some_and(|(new_value, old_value)| new_value >= old_value)
}

fn share_price_did_not_increase(
    assets_before: i128,
    shares_before: i128,
    assets_after: i128,
    shares_after: i128,
) -> bool {
    let old_assets = assets_before + OFFSET;
    let old_shares = shares_before + OFFSET;
    let new_assets = assets_after + OFFSET;
    let new_shares = shares_after + OFFSET;

    new_assets
        .checked_mul(old_shares)
        .zip(old_assets.checked_mul(new_shares))
        .is_some_and(|(new_value, old_value)| new_value <= old_value)
}

#[test]
fn generated_accounting_state_machines_preserve_vault_invariants() {
    let mut runner = TestRunner::new(Config {
        cases: CASES,
        max_shrink_iters: 4_096,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        failure_persistence: None,
        ..Config::default()
    });

    runner
        .run(&operation_sequence_strategy(), |operations| {
            let (env, _admin, first_user, usdc, musdc, mut adapter, vault) = setup();
            let users = [first_user, Address::generate(&env), Address::generate(&env)];
            let treasury = vault.get_treasury();
            let issuer = StellarAssetClient::new(&env, &usdc);
            for user in users.iter().skip(1) {
                issuer.mint(user, &FUNDING);
            }
            issuer.mint(&users[0], &FUNDING);

            for (step, operation) in operations.iter().enumerate() {
                match operation {
                    Operation::Deposit { user, amount } => {
                        let user = &users[*user];
                        let supply_before = vault.get_total_shares();
                        let assets_before = vault.get_total_assets();
                        let expected_shares = amount.checked_mul(supply_before + OFFSET).unwrap()
                            / (assets_before + OFFSET);

                        if expected_shares > 0 {
                            let principal_before = vault.get_principal(user);
                            let balance_before = MockMusdcClient::new(&env, &musdc).balance(user);
                            let adapter_shares_before =
                                MockAdapterClient::new(&env, &adapter).total_shares();
                            let result = vault.try_deposit(user, amount, &0);
                            let minted = match result {
                                Ok(Ok(shares)) => Some(shares),
                                Err(Ok(ContractError::DepositValueMismatch))
                                    if supply_before == 0 && assets_before > 0 =>
                                {
                                    None
                                }
                                Err(Ok(ContractError::AdapterCreditedNothing)) => None,
                                other => {
                                    return Err(TestCaseError::fail(format!(
                                        "deposit failed at step {step}: {other:?}"
                                    )));
                                }
                            };
                            if let Some(minted) = minted {
                                prop_assert!(
                                    minted > 0 && minted <= expected_shares,
                                    "deposit minted outside its pre-deposit quote at step {}",
                                    step
                                );
                                prop_assert_eq!(
                                    vault.get_principal(user),
                                    principal_before + amount,
                                    "deposit did not add its amount to principal at step {}",
                                    step
                                );

                                let assets_after = vault.get_total_assets();
                                prop_assert!(
                                    share_price_did_not_decrease(
                                        assets_before,
                                        supply_before,
                                        assets_after,
                                        vault.get_total_shares()
                                    ),
                                    "deposit diluted the virtual-offset share price at step {}",
                                    step
                                );
                            } else {
                                prop_assert_eq!(vault.get_total_shares(), supply_before);
                                prop_assert_eq!(vault.get_principal(user), principal_before);
                                prop_assert_eq!(
                                    MockMusdcClient::new(&env, &musdc).balance(user),
                                    balance_before
                                );
                                prop_assert_eq!(
                                    MockAdapterClient::new(&env, &adapter).total_shares(),
                                    adapter_shares_before
                                );
                                prop_assert_eq!(vault.get_total_assets(), assets_before);
                            }
                        } else {
                            // A dust-sized deposit must be rejected, not silently
                            // skipped, and a rejection must leave the vault untouched.
                            let principal_before = vault.get_principal(user);
                            let result = vault.try_deposit(user, amount, &0);
                            prop_assert_eq!(
                                result,
                                Err(Ok(ContractError::DepositTooSmall)),
                                "dust deposit was not rejected at step {}",
                                step
                            );
                            prop_assert_eq!(vault.get_total_shares(), supply_before);
                            prop_assert_eq!(vault.get_principal(user), principal_before);
                            prop_assert_eq!(vault.get_total_assets(), assets_before);
                        }
                    }
                    Operation::Withdraw { user, percent } => {
                        let user = &users[*user];
                        let holder_shares = vault.get_position(user);
                        let shares = holder_shares * i128::from(*percent) / 100;
                        let supply_before = vault.get_total_shares();
                        let adapter_shares = MockAdapterClient::new(&env, &adapter).total_shares();
                        let adapter_assets = TokenClient::new(&env, &usdc).balance(&adapter);

                        if shares > 0 && adapter_shares > 0 && supply_before > 0 {
                            let adapter_shares_to_burn = shares * adapter_shares / supply_before;
                            let usdc_out = adapter_shares_to_burn * adapter_assets / adapter_shares;
                            if adapter_shares_to_burn > 0 && usdc_out > 0 {
                                let principal = vault.get_principal(user);
                                let user_usdc_before = TokenClient::new(&env, &usdc).balance(user);
                                let principal_out = principal * shares / holder_shares;
                                let gain = (usdc_out - principal_out).max(0);
                                let fee = gain * PERFORMANCE_FEE_BPS / BPS_DENOMINATOR;
                                let remaining_assets = adapter_assets - usdc_out;
                                let treasury_shares = if fee > 0 {
                                    fee * (supply_before - shares + OFFSET)
                                        / (remaining_assets + OFFSET)
                                } else {
                                    0
                                };
                                let expected_output = if fee > 0 && treasury_shares == 0 {
                                    usdc_out
                                } else {
                                    usdc_out - fee
                                };
                                let expected_principal = if shares == holder_shares {
                                    0
                                } else {
                                    principal - principal_out
                                };
                                let treasury_shares_before =
                                    MockMusdcClient::new(&env, &musdc).balance(&treasury);

                                let result = vault.try_withdraw(user, &shares, &0);
                                let withdrawn = match result {
                                    Ok(Ok(amount)) => Some(amount),
                                    Err(Ok(ContractError::AdapterCreditedNothing)) => {
                                        prop_assert_eq!(vault.get_total_shares(), supply_before);
                                        prop_assert_eq!(vault.get_position(user), holder_shares);
                                        prop_assert_eq!(vault.get_principal(user), principal);
                                        prop_assert_eq!(
                                            TokenClient::new(&env, &usdc).balance(user),
                                            user_usdc_before
                                        );
                                        prop_assert_eq!(
                                            TokenClient::new(&env, &usdc).balance(&adapter),
                                            adapter_assets
                                        );
                                        prop_assert_eq!(
                                            MockAdapterClient::new(&env, &adapter).total_shares(),
                                            adapter_shares
                                        );
                                        prop_assert_eq!(
                                            MockMusdcClient::new(&env, &musdc).balance(&treasury),
                                            treasury_shares_before
                                        );
                                        None
                                    }
                                    other => {
                                        return Err(TestCaseError::fail(format!(
                                            "withdraw failed at step {step}: {other:?}"
                                        )));
                                    }
                                };
                                if let Some(withdrawn) = withdrawn {
                                    prop_assert_eq!(
                                        withdrawn,
                                        expected_output,
                                        "withdrawal fee/output accounting mismatch at step {}",
                                        step
                                    );
                                    prop_assert_eq!(
                                        vault.get_principal(user),
                                        expected_principal,
                                        "withdrawal principal accounting mismatch at step {}",
                                        step
                                    );
                                    prop_assert_eq!(
                                        MockMusdcClient::new(&env, &musdc).balance(&treasury)
                                            - treasury_shares_before,
                                        treasury_shares,
                                        "treasury fee shares mismatch at step {}",
                                        step
                                    );
                                }
                            }
                        }
                    }
                    Operation::Transfer { from, to, percent } if from != to => {
                        let sender = &users[*from];
                        let receiver = &users[*to];
                        let sender_shares = vault.get_position(sender);
                        let shares = sender_shares * i128::from(*percent) / 100;

                        if shares > 0 {
                            let principal_before = total_user_principal(&vault, &users);
                            let result = MockMusdcClient::new(&env, &musdc)
                                .try_transfer(sender, receiver, &shares);
                            prop_assert!(
                                result.is_ok(),
                                "share transfer failed at step {}: {:?}",
                                step,
                                result
                            );
                            prop_assert!(
                                total_user_principal(&vault, &users) <= principal_before,
                                "transfer increased aggregate principal at step {}",
                                step
                            );
                        }
                    }
                    Operation::Transfer { .. } => {}
                    Operation::AdapterGain { amount } => {
                        let assets_before = vault.get_total_assets();
                        let shares_before = vault.get_total_shares();
                        issuer.mint(&adapter, amount);
                        prop_assert!(
                            share_price_did_not_decrease(
                                assets_before,
                                shares_before,
                                vault.get_total_assets(),
                                vault.get_total_shares()
                            ),
                            "adapter gain decreased share price at step {}",
                            step
                        );
                    }
                    Operation::AdapterLoss { percent } => {
                        let adapter_assets = TokenClient::new(&env, &usdc).balance(&adapter);
                        let loss = adapter_assets * i128::from(*percent) / 100;
                        if loss > 0 {
                            let shares_before = vault.get_total_shares();
                            TokenClient::new(&env, &usdc).burn(&adapter, &loss);
                            prop_assert!(
                                share_price_did_not_increase(
                                    adapter_assets,
                                    shares_before,
                                    vault.get_total_assets(),
                                    vault.get_total_shares()
                                ),
                                "adapter loss increased share price at step {}",
                                step
                            );
                        }
                    }
                    Operation::Migrate => {
                        if vault.get_total_shares() > 0
                            && MockAdapterClient::new(&env, &adapter).total_shares() > 0
                            && vault.get_total_assets() > 0
                        {
                            let shares_before = vault.get_total_shares();
                            let principals_before: Vec<i128> =
                                users.iter().map(|user| vault.get_principal(user)).collect();
                            let target = env.register(MockAdapter, ());
                            MockAdapterClient::new(&env, &target).initialize(&usdc);
                            let begin = vault.try_begin_migration(&target);
                            prop_assert_eq!(
                                begin,
                                Ok(Ok(())),
                                "migration setup failed at step {}",
                                step
                            );
                            env.ledger()
                                .with_mut(|ledger| ledger.sequence_number += MIN_LEDGER_GAP);
                            let migrated = vault.try_migrate_adapter(&target, &0);
                            prop_assert_eq!(
                                migrated,
                                Ok(Ok(())),
                                "migration failed at step {}",
                                step
                            );
                            adapter = target;
                            prop_assert_eq!(
                                vault.get_total_shares(),
                                shares_before,
                                "migration changed user share supply at step {}",
                                step
                            );
                            let principals_after: Vec<i128> =
                                users.iter().map(|user| vault.get_principal(user)).collect();
                            prop_assert_eq!(
                                principals_after,
                                principals_before,
                                "migration changed user principal at step {}",
                                step
                            );
                        }
                    }
                }

                if let Err(violation) = check_accounting_invariants(
                    &env, &vault, &users, &treasury, &usdc, &musdc, &adapter,
                ) {
                    return Err(TestCaseError::fail(format!(
                        "accounting invariant failed after step {step} ({operation:?}): {violation}"
                    )));
                }
            }
            Ok(())
        })
        .unwrap_or_else(|error| {
            panic!("vault accounting property failed (seed {PROPERTY_SEED:#x}): {error}")
        });
}

#[test]
fn invariant_suite_detects_a_broken_supply_update() {
    let (env, _admin, user, usdc, musdc, adapter, vault) = setup();
    vault.deposit(&user, &100_0000000, &0);
    let treasury = vault.get_treasury();
    let users = [user];

    env.as_contract(&vault.address, || {
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap();
        env.storage().instance().set(&TOTAL_SH, &(total_shares + 1));
    });

    let violation =
        check_accounting_invariants(&env, &vault, &users, &treasury, &usdc, &musdc, &adapter)
            .expect_err("the deliberately broken total-supply update must be detected");
    assert!(violation.contains("mUSDC supply mismatch"));
}
