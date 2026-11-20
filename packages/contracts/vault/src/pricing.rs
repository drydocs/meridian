//! Pure pricing and fee helpers shared by `deposit`, `withdraw` and the
//! read-only preview / conversion views.
//!
//! Nothing in this module touches the environment, storage or any other
//! contract, so a preview and the matching state-changing call cannot diverge:
//! both feed the same inputs through the same functions. Every helper keeps the
//! checked-arithmetic error mapping the entry points always used
//! (`Overflow` for a failed multiply/add, `DivisionByZero` for a zero divisor).

use crate::errors::ContractError;
use crate::storage::OFFSET;

/// Fixed-point scale of [`share_price`]: `PRICE_SCALE` means one asset stroop
/// per share stroop (a price of exactly 1.0).
pub const PRICE_SCALE: i128 = 10_000_000;

/// Shares minted for `assets` under virtual-offset pricing:
/// `assets * (total_shares + OFFSET) / (total_assets + OFFSET)`, rounded down.
///
/// Used for user deposits and, against the post-withdrawal vault, for the
/// treasury's performance-fee mint.
pub fn shares_for_assets(
    assets: i128,
    total_shares: i128,
    total_assets: i128,
) -> Result<i128, ContractError> {
    assets
        .checked_mul(
            total_shares
                .checked_add(OFFSET)
                .ok_or(ContractError::Overflow)?,
        )
        .ok_or(ContractError::Overflow)?
        .checked_div(
            total_assets
                .checked_add(OFFSET)
                .ok_or(ContractError::Overflow)?,
        )
        .ok_or(ContractError::DivisionByZero)
}

/// Adapter shares redeemed when burning `shares` vault shares:
/// `shares * total_adapter_shares / total_shares`, rounded down.
pub fn adapter_shares_for_shares(
    shares: i128,
    total_shares: i128,
    total_adapter_shares: i128,
) -> Result<i128, ContractError> {
    shares
        .checked_mul(total_adapter_shares)
        .ok_or(ContractError::Overflow)?
        .checked_div(total_shares)
        .ok_or(ContractError::DivisionByZero)
}

/// Gross USDC an adapter pays for `adapter_shares`, assuming it redeems
/// proportionally to its reported `total_assets`:
/// `adapter_shares * total_assets / total_adapter_shares`, rounded down.
///
/// Returns 0 when the adapter holds no shares (nothing can be redeemed).
pub fn assets_for_adapter_shares(
    adapter_shares: i128,
    total_assets: i128,
    total_adapter_shares: i128,
) -> Result<i128, ContractError> {
    if total_adapter_shares <= 0 {
        return Ok(0);
    }
    adapter_shares
        .checked_mul(total_assets)
        .ok_or(ContractError::Overflow)?
        .checked_div(total_adapter_shares)
        .ok_or(ContractError::DivisionByZero)
}

/// Cost basis retired by withdrawing `shares` of a `caller_shares` position:
/// `principal * shares / caller_shares`, rounded down.
pub fn principal_retired(
    principal: i128,
    shares: i128,
    caller_shares: i128,
) -> Result<i128, ContractError> {
    principal
        .checked_mul(shares)
        .ok_or(ContractError::Overflow)?
        .checked_div(caller_shares)
        .ok_or(ContractError::DivisionByZero)
}

/// Splits a withdrawal into `(gain, fee)`. Only positive gain over the retired
/// basis is fee-bearing; principal and loss recovery are never charged.
pub fn performance_fee(
    usdc_out: i128,
    principal_out: i128,
    fee_bps: i128,
    bps_denominator: i128,
) -> Result<(i128, i128), ContractError> {
    let gain = if usdc_out > principal_out {
        usdc_out
            .checked_sub(principal_out)
            .ok_or(ContractError::Overflow)?
    } else {
        0
    };
    let fee = gain
        .checked_mul(fee_bps)
        .ok_or(ContractError::Overflow)?
        .checked_div(bps_denominator)
        .ok_or(ContractError::DivisionByZero)?;
    Ok((gain, fee))
}

/// Price of one share in assets, scaled by [`PRICE_SCALE`], under the same
/// virtual offset the deposit path uses:
/// `(total_assets + OFFSET) * PRICE_SCALE / (total_shares + OFFSET)`.
///
/// An empty vault prices at exactly `PRICE_SCALE`. A negative reported asset
/// total is treated as zero.
pub fn share_price(total_assets: i128, total_shares: i128) -> Result<i128, ContractError> {
    total_assets
        .max(0)
        .checked_add(OFFSET)
        .ok_or(ContractError::Overflow)?
        .checked_mul(PRICE_SCALE)
        .ok_or(ContractError::Overflow)?
        .checked_div(
            total_shares
                .checked_add(OFFSET)
                .ok_or(ContractError::Overflow)?,
        )
        .ok_or(ContractError::DivisionByZero)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WithdrawalFeeOutcome {
    pub principal_out: i128,
    pub gain: i128,
    pub fee: i128,
    pub treasury_shares: i128,
    pub net_usdc_out: i128,
}

/// Authoritative calculation of withdrawal performance fee, retired principal,
/// treasury shares, and actual net USDC delivered (including dust fee return).
///
/// Both `withdraw_internal`, `preview_withdraw`, and `shares_for_withdraw_assets`
/// call this function to guarantee identical fee, treasury mint, and dust-fee handling.
#[allow(clippy::too_many_arguments)]
pub fn calculate_withdrawal_fee_and_net(
    gross_assets: i128,
    principal: i128,
    shares: i128,
    caller_shares: i128,
    total_shares: i128,
    remaining_assets: i128,
    fee_bps: i128,
    bps_denominator: i128,
) -> Result<WithdrawalFeeOutcome, ContractError> {
    let principal_out = principal_retired(principal, shares, caller_shares)?;
    let (gain, fee) = performance_fee(gross_assets, principal_out, fee_bps, bps_denominator)?;
    let base_net = gross_assets
        .checked_sub(fee)
        .ok_or(ContractError::Overflow)?;
    let mut actual_net = base_net;
    let mut treasury_shares = 0_i128;

    if fee > 0 {
        let remaining_shares = total_shares
            .checked_sub(shares)
            .ok_or(ContractError::Overflow)?;
        treasury_shares = shares_for_assets(fee, remaining_shares, remaining_assets)?;
        if treasury_shares == 0 {
            // Dust fee: minting rounds to zero shares. Return fee USDC to caller.
            actual_net = gross_assets;
        }
    }

    Ok(WithdrawalFeeOutcome {
        principal_out,
        gain,
        fee,
        treasury_shares,
        net_usdc_out: actual_net,
    })
}

/// Computes the minimal shares needed to withdraw `target_assets` net USDC
/// after accounting for proportional adapter redemption, performance fee,
/// and dust fee return.
///
/// Returns `Err(ContractError::InsufficientShares)` if even all `caller_shares`
/// cannot produce `target_assets`.
#[allow(clippy::too_many_arguments)]
pub fn shares_for_withdraw_assets(
    target_assets: i128,
    total_shares: i128,
    total_adapter_shares: i128,
    total_assets: i128,
    caller_shares: i128,
    principal: i128,
    fee_bps: i128,
    bps_denominator: i128,
) -> Result<i128, ContractError> {
    if target_assets <= 0 {
        return Err(ContractError::ZeroAmount);
    }
    if total_shares <= 0 {
        return Err(ContractError::NoSharesOutstanding);
    }
    if total_assets <= 0 || total_adapter_shares <= 0 {
        return Err(ContractError::AdapterReportedNoAssets);
    }
    if caller_shares <= 0 {
        return Err(ContractError::InsufficientShares);
    }

    let net_for_shares = |s: i128| -> Result<i128, ContractError> {
        let adapter_shares = adapter_shares_for_shares(s, total_shares, total_adapter_shares)?;
        let gross = assets_for_adapter_shares(adapter_shares, total_assets, total_adapter_shares)?;
        let remaining_assets = total_assets.saturating_sub(gross);
        let outcome = calculate_withdrawal_fee_and_net(
            gross,
            principal,
            s,
            caller_shares,
            total_shares,
            remaining_assets,
            fee_bps,
            bps_denominator,
        )?;
        Ok(outcome.net_usdc_out)
    };

    let max_possible_net = net_for_shares(caller_shares)?;
    if max_possible_net < target_assets {
        return Err(ContractError::InsufficientShares);
    }

    let mut low = 1_i128;
    let mut high = caller_shares;
    let mut best_shares = caller_shares;

    while low <= high {
        let mid = low.checked_add(high).ok_or(ContractError::Overflow)? / 2;
        let net = net_for_shares(mid)?;
        if net >= target_assets {
            best_shares = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    Ok(best_shares)
}
