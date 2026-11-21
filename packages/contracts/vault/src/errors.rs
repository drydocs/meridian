use soroban_sdk::contracterror;

/// Typed error codes returned by fallible contract entry points. Callers and
/// off-chain indexers can match on the variant instead of parsing panic
/// strings, and the numeric discriminant is stable across ABI changes.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 1,
    /// A state-mutating call was made before `initialize`.
    NotInitialized = 2,
    /// `deposit` was called while `set_paused(true)` is in effect.
    DepositsPaused = 3,
    /// `deposit` or `withdraw` was called with a non-positive amount/share count.
    ZeroAmount = 4,
    /// The deposited amount rounds down to zero shares at the current price.
    DepositTooSmall = 5,
    /// `withdraw` was called while the vault has no shares outstanding.
    NoSharesOutstanding = 6,
    /// The caller does not hold enough mUSDC shares to burn.
    InsufficientShares = 7,
    /// The shares burned round down to zero USDC at the current price.
    WithdrawalTooSmall = 8,
    /// An intermediate arithmetic operation would overflow `i128`.
    Overflow = 9,
    /// `set_adapter` was called while the vault still has shares outstanding
    /// (`TOTAL_SH > 0`) or the old adapter still holds a position
    /// (`ADPT_SH > 0`). The two counters can desync (see `migrate_adapter`'s
    /// `NoAdapterPosition` doc), so both are checked: `TOTAL_SH` alone is not
    /// sufficient evidence that the old adapter is actually empty.
    AdapterSwapUnsafe = 10,
    /// `migrate_adapter` was called with the vault's current adapter as the
    /// target.
    SameAdapter = 11,
    /// `migrate_adapter`'s post-migration value fell outside the caller's
    /// `max_slippage_bps` tolerance of the pre-migration value.
    MigrationValueDrift = 12,
    /// `migrate_adapter` was called while the vault's current adapter has no
    /// position to migrate. Distinct from `NoSharesOutstanding`: this checks
    /// `ADPT_SH` (adapter-side shares), not `TOTAL_SH` (vault mUSDC shares),
    /// and the two can desync.
    NoAdapterPosition = 13,
    /// `migrate_adapter` was called with `max_slippage_bps > 500` (the
    /// `MAX_ADMIN_SLIPPAGE_BPS` cap).
    InvalidSlippageBps = 14,
    /// `withdraw` was called with a `min_usdc_out` floor and the actual
    /// amount out fell below it. Distinct from `WithdrawalTooSmall` (which
    /// fires when `usdc_out` rounds to zero): this fires when `usdc_out > 0`
    /// but the caller's slippage tolerance was not met — i.e. the
    /// ADPT_SH/TOTAL_SH ratio shifted between when the caller estimated
    /// their proceeds and when their transaction landed.
    MinAmountOutNotMet = 15,
    /// `accept_admin` was called with no pending nominee recorded (no
    /// `transfer_admin` call has happened, or a previous nomination was
    /// already accepted).
    NoPendingAdmin = 16,
    /// The adapter reported zero or negative total assets while the vault
    /// still has shares outstanding, indicating a broken adapter or
    /// malformed protocol response. Depositing would dilute all existing
    /// holders. `deposit` checks this both before the adapter call and,
    /// for the pre-existing position, from the post-deposit reads.
    AdapterReportedNoAssets = 17,
    /// `deposit` output fell below caller-specified minimum bound (`min_shares_out`).
    SlippageExceeded = 18,
    /// `migrate_adapter` was called without a prior `begin_migration`
    /// call for the same target adapter.
    MigrationNotInitialized = 19,
    /// `migrate_adapter` was called before the minimum ledger-gap
    /// cooldown since `begin_migration` had elapsed.
    MigrationCooldownNotMet = 20,
    /// The new adapter's `total_assets()` drifted too far from the
    /// snapshot recorded by `begin_migration`, indicating possible
    /// manipulation or instability.
    MigrationStabilityDrift = 21,
    /// `begin_migration` was called against a target adapter reporting a
    /// negative `total_assets()`. A negative snapshot value defeats the
    /// stability check it feeds: the tolerance-scaled floor stays negative
    /// too, so any non-negative pre-deposit balance clears it regardless of
    /// how much the target is drained during the cooldown.
    MigrationSnapshotAssetsInvalid = 22,
    /// `deposit`'s adapter call returned zero or negative shares credited,
    /// indicating the underlying protocol rejected or dropped the deposit.
    /// Minting vault shares against it would dilute every existing holder
    /// with nothing backing the new shares.
    AdapterCreditedNothing = 23,
    /// A `checked_div` returned `None` because the divisor was zero.
    /// Distinct from `Overflow`: this points to a degenerate adapter state
    /// (e.g. zero `total_assets`) rather than a genuine arithmetic overflow.
    DivisionByZero = 24,
    /// `migrate_adapter` read a zero or negative `total_assets()` from the
    /// old adapter while the vault still holds adapter shares. That value is
    /// the baseline for the withdrawal-leg slippage floor; a non-positive
    /// baseline collapses the floor to zero (or below) so the loss guard
    /// would always pass.
    MigrationBaselineInvalid = 25,
    /// A guarded entry point (`deposit`, `withdraw`, `set_adapter`,
    /// `begin_migration`, `migrate_adapter`, or the mUSDC `on_transfer`
    /// callback) was called while another guarded call was still in
    /// progress. This happens when a malicious or compromised adapter or
    /// token calls back into the vault in the middle of an external call,
    /// while `TOTAL_SH`, `ADPT_SH`, `ADAPTER` or migration state is not yet
    /// final. The reentrant call is rejected and the outer call is
    /// unaffected.
    ReentrancyDetected = 26,
    /// `set_adapter` or `begin_migration` was given a target adapter whose
    /// `get_usdc()` differs from the vault's own USDC. Such an adapter would
    /// hold and price a different asset than the vault accounts in, so every
    /// later deposit, withdrawal and migration against it would fail or
    /// misprice. Also raised when the target does not export `get_usdc()`,
    /// the call fails, or the target is not a contract (see
    /// `MeridianVault::validate_adapter_target`).
    AdapterUsdcMismatch = 27,
    /// `set_adapter` or `begin_migration` was given a target adapter whose
    /// `get_vault()` is not this vault. Such an adapter only accepts calls
    /// authorized by another vault, so this vault could never operate it.
    /// Also raised when the target does not export `get_vault()` or the call
    /// fails.
    AdapterVaultMismatch = 28,
    /// `set_adapter` was given a target adapter that already holds a
    /// position (nonzero `total_shares()` or `total_assets()`). The vault is
    /// empty at that point, so any residue would be unaccounted for in
    /// `ADPT_SH` and would skew the share price of the first depositors.
    AdapterResidualPosition = 29,
    /// `deposit`'s adapter reported a credit that its own post-deposit
    /// ledger cannot back: the credited adapter shares, valued at the
    /// adapter's post-deposit `total_assets() / total_shares()`, are worth
    /// more than the USDC the adapter was given or more than its
    /// `total_assets()` grew by, beyond the tolerance set by
    /// `DEPOSIT_VALUE_TOLERANCE_BPS` and `DEPOSIT_VALUE_TOLERANCE_STROOPS`.
    /// Also returned when the credit exceeds the adapter's whole
    /// post-deposit share balance. Minting against such a credit would
    /// dilute every existing holder. A credit worth *less* than requested
    /// (partial fill, supply cap, fee on deposit) is not a mismatch: it is
    /// minted at its real value.
    DepositValueMismatch = 30,
    /// `withdraw_assets` was called and the required shares to redeem `assets`
    /// exceeded the caller's `max_shares_in` cap.
    MaxSharesExceeded = 31,
}
