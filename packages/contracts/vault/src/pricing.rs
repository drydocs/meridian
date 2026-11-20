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
