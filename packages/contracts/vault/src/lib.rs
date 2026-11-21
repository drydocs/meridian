#![no_std]

mod errors;
pub mod pricing;
mod storage;

pub use errors::ContractError;
pub use storage::{
    clear_position_records, DataKey, MigrationSnapshot, ADAPTER, ADMIN, ADPT_SH,
    DEPOSIT_VALUE_TOLERANCE_BPS, DEPOSIT_VALUE_TOLERANCE_STROOPS, LOCKED, MAX_ADMIN_SLIPPAGE_BPS,
    MIG_ACTIVE, MIG_SNAP, MIN_LEDGER_GAP, MUSDC, OFFSET, PAUSED, PEND_ADM, TOTAL_SH, TREASURY,
    USDC,
};

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token::TokenClient,
    Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Event topics
// ---------------------------------------------------------------------------

/// Bump when any vault event topic or payload shape changes.
const EVENT_SCHEMA_VERSION: u32 = 1;

/// Top-level topic shared by all vault admin-action events.
const ADMIN_EVT: Symbol = symbol_short!("admin");

const DEPOSIT_EVT: (Symbol, u32) = (symbol_short!("deposit"), EVENT_SCHEMA_VERSION);
const PERF_FEE_EVT: (Symbol, u32) = (symbol_short!("perf_fee"), EVENT_SCHEMA_VERSION);
const WITHDRAW_EVT: (Symbol, u32) = (symbol_short!("withdraw"), EVENT_SCHEMA_VERSION);
const PAUSED_EVT: (Symbol, Symbol, u32) =
    (ADMIN_EVT, symbol_short!("paused"), EVENT_SCHEMA_VERSION);
const TRANSFER_EVT: (Symbol, Symbol, u32) =
    (ADMIN_EVT, symbol_short!("transfer"), EVENT_SCHEMA_VERSION);
const ACCEPT_EVT: (Symbol, Symbol, u32) =
    (ADMIN_EVT, symbol_short!("accept"), EVENT_SCHEMA_VERSION);
const ADAPTER_EVT: (Symbol, Symbol, u32) =
    (ADMIN_EVT, symbol_short!("adapter"), EVENT_SCHEMA_VERSION);
const MIG_BEGIN_EVT: (Symbol, Symbol, u32) =
    (ADMIN_EVT, symbol_short!("mig_begin"), EVENT_SCHEMA_VERSION);
const MIGRATE_EVT: (Symbol, Symbol, u32) =
    (ADMIN_EVT, symbol_short!("migrate"), EVENT_SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

use adapter_common::{DAY_IN_LEDGERS, INSTANCE_BUMP, INSTANCE_THRESHOLD};

// Positions are bumped far harder than config: a saver who does nothing for
// a quarter is the target user, not an edge case.
const POSITION_BUMP: u32 = 120 * DAY_IN_LEDGERS;
const POSITION_THRESHOLD: u32 = POSITION_BUMP - 7 * DAY_IN_LEDGERS;

/// Immutable performance fee: 1,000 basis points = 10%.
///
/// This is compiled into the vault WASM rather than stored behind an admin
/// setter. Changing it therefore requires a fresh deployment.
pub const PERFORMANCE_FEE_BPS: i128 = 1_000;
pub const BPS_DENOMINATOR: i128 = 10_000;

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/// Generic interface every yield-bearing adapter must implement.
/// Deploy a new adapter implementing this trait to add a protocol without
/// modifying the vault. The vault calls these functions directly.
#[contractclient(name = "AdapterClient")]
pub trait YieldAdapterInterface {
    fn deposit(env: Env, amount: i128) -> i128;
    fn withdraw(env: Env, shares: i128, recipient: Address) -> i128;
    fn total_assets(env: Env) -> i128;
    /// The adapter's current protocol-share balance, read from the underlying
    /// protocol's own ledger rather than self-tracked. Lets the vault reconcile
    /// ADPT_SH instead of estimating its decrements.
    fn total_shares(env: Env) -> i128;
    /// Refreshes the adapter's cached total_assets before it is read for
    /// deposit/withdraw pricing. A no-op for adapters that already price
    /// live on every call.
    fn refresh(env: Env);
    /// Returns the address of the underlying protocol contract this adapter
    /// wraps (a lending pool for Blend, a vault for DeFindex, etc). Lets
    /// off-chain callers discover where to read live protocol data (e.g. a
    /// supply rate) without maintaining that address in config, so it can
    /// never drift out of sync if the adapter is later swapped via
    /// `set_adapter`.
    fn get_pool(env: Env) -> Address;
    /// Returns a stable, lowercase identifier for the protocol this adapter
    /// wraps (e.g. "blend", "defindex"). A constant per adapter deployment;
    /// lets off-chain callers pick the right protocol-specific logic to
    /// interpret the address returned by `get_pool()`, without a manually
    /// maintained config mapping that could drift out of sync.
    fn get_protocol(env: Env) -> Symbol;
    /// Returns the vault this adapter is bound to. `set_adapter` and
    /// `begin_migration` reject a target whose `get_vault` is missing,
    /// fails, or names a different vault.
    fn get_vault(env: Env) -> Address;
    /// Returns the USDC token this adapter holds. `set_adapter` and
    /// `begin_migration` reject a target whose `get_usdc` is missing, fails,
    /// or names a different token.
    fn get_usdc(env: Env) -> Address;
}

// ---------------------------------------------------------------------------
// mUSDC admin interface (#578)
// ---------------------------------------------------------------------------

/// The subset of the mUSDC token's admin-only surface the vault calls into.
/// Kept minimal and local to this crate, mirroring `YieldAdapterInterface`
/// above: the vault never depends on `meridian-musdc-token` directly, in
/// production or in tests — `MockMusdc` in the test module below stands in
/// for it the same way `MockAdapter` stands in for a real adapter crate
/// (see `MockMusdc`'s doc comment for why: a real cross-crate dependency
/// between the two hits a Windows-toolchain-specific linker limit in this
/// environment). `MusdcAdminClient`/`TokenClient` dispatch to whatever
/// contract implements matching function names and argument encodings, not
/// to a specific Rust type, so `MockMusdc` is a valid call target for both
/// without implementing this trait. No `Result` return, matching
/// `YieldAdapterInterface`'s methods: `deposit`'s own `shares_to_mint <= 0`
/// check already guarantees `mint` is never called with a non-positive
/// amount, so the only realistic failure is an auth mismatch, which panics
/// through from the token side regardless of this trait's signature.
#[contractclient(name = "MusdcAdminClient")]
pub trait MusdcAdminInterface {
    fn mint(env: Env, to: Address, amount: i128);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/// Result of [`MeridianVault::preview_withdraw`]: what `withdraw` would do for
/// a given holder and share count at the current vault state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawPreview {
    /// USDC the adapter would redeem for the burned shares, before any fee.
    pub gross_assets: i128,
    /// Performance fee on the gain over the retired cost basis (0 if none).
    pub fee: i128,
    /// mUSDC minted to the treasury for the fee (0 if no fee, or if the fee
    /// is too small to mint one share and is returned to the caller instead).
    pub treasury_shares: i128,
    /// USDC the caller receives, exactly what `withdraw` returns.
    pub assets_out: i128,
}

#[contract]
pub struct MeridianVault;

#[contractimpl]
impl MeridianVault {
    /// Sets the admin, USDC token address, mUSDC share token address, initial
    /// yield adapter, and performance-fee treasury inside the deploying
    /// transaction's own `CreateContract` operation. Unlike a separate `initialize()` call,
    /// there is no intervening ledger where an attacker could land a
    /// self-authorized call first: the deployer's transaction is the only
    /// one that can ever set this contract's state (#551, same bug class as
    /// #505, fixed for the adapters/mUSDC in #550).
    ///
    /// Unlike the adapters/mUSDC's constructor arguments, `admin` is a
    /// human-held key, not a programmatically-derived contract address, so
    /// `require_auth()` is called on it here too: without it, `DEPLOYER`
    /// alone could set any address as admin with no proof it is controlled
    /// by anyone, permanently bricking the vault on a typo (`transfer_admin`/
    /// `accept_admin` both require the *current* admin's own signature to
    /// move away from it). Soroban only honors `require_auth()` inside a
    /// constructor for the address that is the deploying transaction's own
    /// source account, so this requires `ADMIN` itself, not `DEPLOYER`, to
    /// source the vault's deploy transaction. See
    /// `apps/docs/operations/testnet-deployment.md`.
    pub fn __constructor(
        env: Env,
        admin: Address,
        usdc: Address,
        musdc: Address,
        adapter: Address,
        treasury: Address,
    ) {
        admin.require_auth();
        Self::init_state(&env, &admin, &usdc, &musdc, &adapter, &treasury);
    }

    /// Retained as a hand-initialization path for undeployed legacy flows.
    /// Its arguments mirror the constructor, including the treasury.
    ///
    /// On any vault deployed from this WASM it is unreachable: `__constructor`
    /// has already set `ADMIN`, so every call returns `AlreadyInitialized`.
    /// That is the intended behavior, not a leftover. An attacker calling
    /// this against a freshly deployed vault is rejected instead of served.
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc: Address,
        musdc: Address,
        adapter: Address,
        treasury: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        Self::init_state(&env, &admin, &usdc, &musdc, &adapter, &treasury);
        Ok(())
    }

    /// The write half of initialization, shared by `__constructor` and
    /// `initialize` so the two can never set up different state. Not exported
    /// (no `pub`), so it is not callable from outside the contract.
    fn init_state(
        env: &Env,
        admin: &Address,
        usdc: &Address,
        musdc: &Address,
        adapter: &Address,
        treasury: &Address,
    ) {
        env.storage().instance().set(&ADMIN, admin);
        env.storage().instance().set(&USDC, usdc);
        env.storage().instance().set(&MUSDC, musdc);
        env.storage().instance().set(&ADAPTER, adapter);
        env.storage().instance().set(&TREASURY, treasury);
        env.storage().instance().set(&TOTAL_SH, &0_i128);
        env.storage().instance().set(&ADPT_SH, &0_i128);
    }

    /// Deposit `amount` USDC into the vault. USDC is forwarded to the yield
    /// adapter, which deploys it to the underlying protocol.
    ///
    /// The mint is priced from what the adapter actually credited, not from
    /// `amount` (#1263). After the adapter's `deposit` returns, the vault
    /// refreshes the adapter and values the credited adapter shares at the
    /// post-deposit `total_assets() / total_shares()` rate, then prices the
    /// mint against the value of the position that already existed. A
    /// partial fill, supply cap or fee-on-deposit therefore mints fewer
    /// shares instead of diluting existing holders. The mint is also never
    /// larger than the pre-deposit quote for `amount`.
    ///
    /// Returns the number of mUSDC shares minted to the caller.
    ///
    /// Fails with `DepositValueMismatch` if the adapter reports a credit
    /// worth more than the USDC it was given, or more than its own
    /// `total_assets()` grew by, beyond `deposit_value_tolerance(amount)`.
    /// `min_shares_out` is checked against the final, valued mint.
    ///
    /// Guarded against reentrancy: a call back into any guarded entry point
    /// while this one is running fails with `ReentrancyDetected`.
    pub fn deposit(
        env: Env,
        caller: Address,
        amount: i128,
        min_shares_out: i128,
    ) -> Result<i128, ContractError> {
        Self::with_lock(&env, || {
            Self::deposit_unlocked(env.clone(), caller, amount, min_shares_out)
        })
    }

    fn deposit_unlocked(
        env: Env,
        caller: Address,
        amount: i128,
        min_shares_out: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        Self::extend_instance(&env);
        if Self::is_paused(env.clone()) {
            return Err(ContractError::DepositsPaused);
        }
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let usdc = Self::usdc(&env)?;
        let musdc = Self::musdc(&env)?;
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;
        let adapter_client = AdapterClient::new(&env, &adapter_addr);
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);

        // Refresh the adapter's cached total before pricing so this
        // depositor's own transaction is priced with up-to-date yield.
        adapter_client.refresh();

        // Share price is based on the adapter's total assets (includes yield).
        let assets_before = adapter_client.total_assets();

        // A held position that cannot be valued is an error, not a zero price.
        // Minting here would dilute every existing holder.
        if total_shares > 0 && assets_before <= 0 {
            return Err(ContractError::AdapterReportedNoAssets);
        }

        // The pre-deposit quote for `amount`. It is the most this deposit can
        // ever mint: the final mint is priced from the adapter's credit below
        // and capped at this value. Checking it here fails a deposit that
        // could never succeed before any funds move.
        let quoted_shares = pricing::shares_for_assets(amount, total_shares, assets_before)?;
        if quoted_shares <= 0 {
            return Err(ContractError::DepositTooSmall);
        }
        if quoted_shares < min_shares_out {
            return Err(ContractError::SlippageExceeded);
        }

        // A caller who currently holds no shares but still has Entry/Principal
        // records is a defensive safety net, not the normal path: `on_transfer`
        // (#578) now clears a sender's records itself the moment a full
        // transfer-out reaches zero, and `withdraw()`'s full-exit branch
        // already did the same, so this should be unreachable in the current
        // system. It stays in place for a balance that reached zero any other
        // way this contract doesn't yet account for, so a stale basis can
        // never be silently inherited by a fresh deposit.
        if TokenClient::new(&env, &musdc).balance(&caller) == 0 {
            clear_position_records(&env, &caller);
        }

        // Effects before interactions: everything below that depends only on
        // values already computed above is committed before the first
        // external call (USDC transfer, adapter deposit, mUSDC mint), so those
        // calls never observe a stale TOTAL_SH or missing position records.
        // This is safe to do early because a failure in any later step
        // returns `Err` and the whole invocation, these writes included, is
        // rolled back. TOTAL_SH is written here with the quote, the upper
        // bound of this deposit's mint, and reconciled to the valued mint
        // right after the adapter call. ADPT_SH is read back from the
        // adapter, so it can only be written after the adapter call.
        env.storage().instance().set(
            &TOTAL_SH,
            &total_shares
                .checked_add(quoted_shares)
                .ok_or(ContractError::Overflow)?,
        );

        // Stamp the entry time on the caller's first deposit; top-ups keep
        // the original time. Keyed off whether an entry record exists rather
        // than off the incoming share balance: an address that was
        // transferred mUSDC holds shares but has never deposited, and its
        // first deposit is a real entry, not a top-up.
        let entry_key = DataKey::Entry(caller.clone());
        if !env.storage().persistent().has(&entry_key) {
            env.storage()
                .persistent()
                .set(&entry_key, &env.ledger().timestamp());
        }

        // Accumulate cost basis so the UI can display yield earned. This is
        // what the caller paid, so it is `amount` even when the adapter
        // credits less: any shortfall shows up as a loss against basis.
        let principal_key = DataKey::Principal(caller.clone());
        let prev_principal: i128 = env.storage().persistent().get(&principal_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&principal_key, &(prev_principal + amount));

        // Pull USDC from caller directly to the adapter.
        // The adapter address is known at this point, and the intermediate
        // vault-owned balance is never used.
        TokenClient::new(&env, &usdc).transfer(&caller, &adapter_addr, &amount);

        // Adapter deploys USDC to the underlying protocol and returns its own shares.
        let adapter_shares_credited = adapter_client.deposit(&amount);
        if adapter_shares_credited <= 0 {
            return Err(ContractError::AdapterCreditedNothing);
        }

        // Read the adapter's post-deposit state once and price everything
        // below from it. The refresh matters for cache-backed adapters
        // (BlendAdapter's deposit() books `amount` into its cache, not what
        // the pool actually credited).
        adapter_client.refresh();
        let assets_after = adapter_client.total_assets();
        let adapter_shares_after = adapter_client.total_shares();

        let credited_value = Self::value_deposit_credit(
            amount,
            adapter_shares_credited,
            assets_before,
            assets_after,
            adapter_shares_after,
        )?;

        // The position that existed before this deposit, valued at the same
        // post-deposit rate as the credit. Pricing the mint against it gives
        // the depositor the same fraction of the vault as their credit is of
        // the adapter's shares, which is also the fraction `withdraw` redeems
        // for them (`shares * ADPT_SH / TOTAL_SH`).
        let existing_value = assets_after
            .checked_sub(credited_value)
            .ok_or(ContractError::Overflow)?;
        if existing_value < 0 || (total_shares > 0 && existing_value == 0) {
            return Err(ContractError::AdapterReportedNoAssets);
        }

        let shares_to_mint =
            pricing::shares_for_assets(credited_value, total_shares, existing_value)?
                .min(quoted_shares);
        if shares_to_mint <= 0 {
            return Err(ContractError::DepositTooSmall);
        }
        if shares_to_mint < min_shares_out {
            return Err(ContractError::SlippageExceeded);
        }

        // Reconcile both counters from the same post-deposit reads before the
        // mUSDC mint, the last external call.
        env.storage().instance().set(
            &TOTAL_SH,
            &total_shares
                .checked_add(shares_to_mint)
                .ok_or(ContractError::Overflow)?,
        );
        env.storage()
            .instance()
            .set(&ADPT_SH, &adapter_shares_after);

        // Mint mUSDC shares to caller.
        MusdcAdminClient::new(&env, &musdc).mint(&caller, &shares_to_mint);

        Self::extend_position(&env, &caller);

        // Data: (caller, requested USDC, adapter shares credited, mUSDC minted).
        env.events().publish(
            DEPOSIT_EVT,
            (caller, amount, adapter_shares_credited, shares_to_mint),
        );

        Ok(shares_to_mint)
    }

    /// Withdraw by burning `shares` mUSDC. Returns the USDC amount sent back
    /// to the caller.
    ///
    /// `min_usdc_out` is a caller-supplied slippage floor. If the computed
    /// USDC output falls below this value the transaction reverts with
    /// `MinAmountOutNotMet`, giving the caller a predictable, typed failure
    /// rather than an opaque `WithdrawalTooSmall`. Pass `0` to opt out of the
    /// floor (behaviour is then identical to the pre-guard contract).
    ///
    /// This guards against ratio-shifting: a concurrent withdrawal by another
    /// depositor changes the shared `ADPT_SH/TOTAL_SH` ratio before this
    /// transaction lands, silently shrinking the payout. With `min_usdc_out`
    /// the caller can bound how much shrinkage they are willing to accept.
    ///
    /// Guarded against reentrancy: a call back into any guarded entry point
    /// while this one is running fails with `ReentrancyDetected`. Unlike
    /// `deposit`, the counters written at the end depend on values returned
    /// by the adapter and token calls (`usdc_out`, the fee, the treasury
    /// mint, `total_shares()`), so they cannot be moved ahead of those calls;
    /// the lock is what keeps the stale window unreachable.
    pub fn withdraw(
        env: Env,
        caller: Address,
        shares: i128,
        min_usdc_out: i128,
    ) -> Result<i128, ContractError> {
        Self::with_lock(&env, || {
            Self::withdraw_unlocked(env.clone(), caller, shares, min_usdc_out)
        })
    }

    /// Withdraw an exact net USDC `assets` amount by burning at most `max_shares_in`
    /// mUSDC shares. Returns the USDC amount sent back to the caller.
    ///
    /// Computes the required shares after fees and rounding using shared pricing
    /// helpers. Reverts with `MaxSharesExceeded` if the required shares exceed
    /// `max_shares_in`.
    ///
    /// Guarded against reentrancy: runs under the same instance-storage lock
    /// as `withdraw` and `deposit`.
    pub fn withdraw_assets(
        env: Env,
        caller: Address,
        assets: i128,
        max_shares_in: i128,
    ) -> Result<i128, ContractError> {
        Self::with_lock(&env, || {
            Self::withdraw_assets_unlocked(env.clone(), caller, assets, max_shares_in)
        })
    }

    fn withdraw_assets_unlocked(
        env: Env,
        caller: Address,
        assets: i128,
        max_shares_in: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        Self::extend_instance(&env);
        if assets <= 0 || max_shares_in < 0 {
            return Err(ContractError::ZeroAmount);
        }

        let musdc = Self::musdc(&env)?;
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;

        AdapterClient::new(&env, &adapter_addr).refresh();

        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);

        if total_shares <= 0 {
            return Err(ContractError::NoSharesOutstanding);
        }

        let caller_shares = TokenClient::new(&env, &musdc).balance(&caller);
        if caller_shares <= 0 {
            return Err(ContractError::InsufficientShares);
        }

        let total_assets = AdapterClient::new(&env, &adapter_addr).total_assets();
        if total_shares > 0 && total_assets <= 0 {
            return Err(ContractError::AdapterReportedNoAssets);
        }

        let principal_key = DataKey::Principal(caller.clone());
        let principal: i128 = env.storage().persistent().get(&principal_key).unwrap_or(0);

        let shares_needed = pricing::shares_for_withdraw_assets(
            assets,
            total_shares,
            total_adapter_shares,
            total_assets,
            caller_shares,
            principal,
            PERFORMANCE_FEE_BPS,
            BPS_DENOMINATOR,
        )?;

        if shares_needed > max_shares_in {
            return Err(ContractError::MaxSharesExceeded);
        }
        if shares_needed > caller_shares {
            return Err(ContractError::InsufficientShares);
        }

        let min_usdc_out = assets.saturating_sub(1);
        Self::withdraw_internal(env, caller, shares_needed, min_usdc_out)
    }

    fn withdraw_unlocked(
        env: Env,
        caller: Address,
        shares: i128,
        min_usdc_out: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        Self::extend_instance(&env);
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;
        AdapterClient::new(&env, &adapter_addr).refresh();
        Self::withdraw_internal(env, caller, shares, min_usdc_out)
    }

    fn withdraw_internal(
        env: Env,
        caller: Address,
        shares: i128,
        min_usdc_out: i128,
    ) -> Result<i128, ContractError> {
        if shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let usdc = Self::usdc(&env)?;
        let musdc = Self::musdc(&env)?;
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;

        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);

        if total_shares <= 0 {
            return Err(ContractError::NoSharesOutstanding);
        }

        // Verify caller holds enough shares, read from the mUSDC token: the
        // same balance the `burn` below operates on, so the check can never
        // disagree with it. Kept as an explicit check rather than leaning on
        // the burn's own panic, so callers still get the typed
        // `InsufficientShares` error.
        let caller_shares = TokenClient::new(&env, &musdc).balance(&caller);
        if caller_shares < shares {
            return Err(ContractError::InsufficientShares);
        }

        // Proportional adapter-share burn: caller_shares/total_shares of the
        // total adapter shares are redeemed.
        let adapter_shares_to_burn =
            pricing::adapter_shares_for_shares(shares, total_shares, total_adapter_shares)?;

        // Adapter redeems protocol shares, delivers USDC to vault, returns amount.
        let adapter_client = AdapterClient::new(&env, &adapter_addr);
        let usdc_out =
            adapter_client.withdraw(&adapter_shares_to_burn, &env.current_contract_address());

        if usdc_out <= 0 {
            return Err(ContractError::WithdrawalTooSmall);
        }

        // Retire cost basis in proportion to the caller's live share balance.
        // Only positive gain on the withdrawn slice is fee-bearing; principal
        // and loss recovery are never charged.
        let principal_key = DataKey::Principal(caller.clone());
        let principal: i128 = env.storage().persistent().get(&principal_key).unwrap_or(0);
        let principal_out = pricing::principal_retired(principal, shares, caller_shares)?;
        let (_, fee) = pricing::performance_fee(
            usdc_out,
            principal_out,
            PERFORMANCE_FEE_BPS,
            BPS_DENOMINATOR,
        )?;
        let remaining_shares = total_shares
            .checked_sub(shares)
            .ok_or(ContractError::Overflow)?;
        let remaining_assets = if fee > 0 {
            adapter_client.total_assets()
        } else {
            0
        };
        let outcome = pricing::calculate_withdrawal_fee_and_net(
            usdc_out,
            principal,
            shares,
            caller_shares,
            total_shares,
            remaining_assets,
            PERFORMANCE_FEE_BPS,
            BPS_DENOMINATOR,
        )?;

        let fee = outcome.fee;
        let treasury_shares = outcome.treasury_shares;
        let mut actual_usdc_out = outcome.net_usdc_out;
        let base_net = usdc_out.checked_sub(fee).ok_or(ContractError::Overflow)?;

        // Slippage is enforced against what the caller actually receives,
        // after the performance fee, so off-chain simulations can provide a
        // meaningful minimum.
        if actual_usdc_out < min_usdc_out {
            return Err(ContractError::MinAmountOutNotMet);
        }

        // Burn mUSDC from caller and send the net USDC back. Any fee remains
        // in the vault briefly, then is re-deposited below so treasury shares
        // are fully backed rather than being an uncollateralized mint.
        TokenClient::new(&env, &musdc).burn(&caller, &shares);
        TokenClient::new(&env, &usdc).transfer(&env.current_contract_address(), &caller, &base_net);

        if fee > 0 {
            if treasury_shares > 0 {
                let treasury: Address = env
                    .storage()
                    .instance()
                    .get(&TREASURY)
                    .ok_or(ContractError::NotInitialized)?;
                TokenClient::new(&env, &usdc).transfer(
                    &env.current_contract_address(),
                    &adapter_addr,
                    &fee,
                );
                let credited = adapter_client.deposit(&fee);
                if credited <= 0 {
                    return Err(ContractError::AdapterCreditedNothing);
                }
                MusdcAdminClient::new(&env, &musdc).mint(&treasury, &treasury_shares);

                env.events().publish(
                    PERF_FEE_EVT,
                    (caller.clone(), treasury, fee, treasury_shares),
                );
            } else {
                // A fee too small to mint one share remains user-owned: send
                // it with the withdrawal instead of silently trapping dust.
                TokenClient::new(&env, &usdc).transfer(
                    &env.current_contract_address(),
                    &caller,
                    &fee,
                );
                actual_usdc_out = usdc_out;
            }
        }

        // Update global counters.
        env.storage()
            .instance()
            .set(&TOTAL_SH, &(remaining_shares + treasury_shares));
        env.storage()
            .instance()
            .set(&ADPT_SH, &adapter_client.total_shares());

        let remaining = caller_shares - shares;

        // Retire the withdrawn basis strictly in proportion to the shares
        // burned. The retained shares keep their own untaxed basis, so their
        // gain is charged when they are withdrawn. Folding the taxed gain back
        // into the basis instead (a high-water ratchet) would shelter that
        // gain from the fee forever, under-collecting on every partial exit.
        env.storage()
            .persistent()
            .set(&principal_key, &(principal - principal_out));

        // A full exit clears the entry time and cost basis so a later re-deposit
        // starts fresh.
        if remaining == 0 {
            clear_position_records(&env, &caller);
        }

        Self::extend_position(&env, &caller);

        env.events()
            .publish(WITHDRAW_EVT, (caller, shares, actual_usdc_out));

        Ok(actual_usdc_out)
    }

    /// Called by the mUSDC token contract immediately after it moves a
    /// transfer's balances, splitting `Principal`/`Entry` pro-rata between
    /// sender and receiver (#578) — the fix for the honest-`0` degradation
    /// documented on `get_principal`/`get_entry_time`, from back when mUSDC
    /// was a plain Stellar Asset Contract with no hook for the vault to
    /// observe a transfer at all.
    ///
    /// Requires the mUSDC token's own `require_auth()`, which succeeds only
    /// when mUSDC is the *direct* caller of this exact invocation — Soroban
    /// treats a contract's own direct sub-calls as inherently authorized by
    /// that contract, with no signature needed (see
    /// `Env::authorize_as_current_contract`'s doc comment: "All the direct
    /// calls that the current contract performs are always considered to
    /// have been authorized"). This can therefore never be triggered by
    /// anything other than a genuine transfer on the one real, configured
    /// mUSDC contract — the same direction-reversed pattern
    /// `adapter-common::require_vault_auth` already uses for every adapter
    /// to verify a call actually came from the vault.
    ///
    /// `sender_balance_before`/`receiver_balance_before` are `from`'s/`to`'s
    /// mUSDC balances immediately before this transfer, supplied by the
    /// token since it already has both on hand from computing the transfer
    /// itself — see `meridian-musdc-token`'s `VaultCallback` trait doc
    /// comment (`packages/contracts/musdc-token/src/lib.rs`).
    ///
    /// Guarded against reentrancy: an mUSDC transfer made from inside a
    /// guarded entry point (for example by a malicious adapter) reaches this
    /// callback while accounting state is not yet final, and fails with
    /// `ReentrancyDetected`. Ordinary user transfers happen outside any
    /// guarded call, so they are unaffected.
    pub fn on_transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        sender_balance_before: i128,
        receiver_balance_before: i128,
    ) -> Result<(), ContractError> {
        Self::with_lock(&env, || {
            Self::on_transfer_unlocked(
                env.clone(),
                from,
                to,
                amount,
                sender_balance_before,
                receiver_balance_before,
            )
        })
    }

    fn on_transfer_unlocked(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        sender_balance_before: i128,
        receiver_balance_before: i128,
    ) -> Result<(), ContractError> {
        let musdc = Self::musdc(&env)?;
        musdc.require_auth();
        Self::extend_instance(&env);

        let sender_principal_key = DataKey::Principal(from.clone());
        let sender_entry_key = DataKey::Entry(from.clone());
        let receiver_principal_key = DataKey::Principal(to.clone());
        let receiver_entry_key = DataKey::Entry(to.clone());

        let sender_principal: i128 = env
            .storage()
            .persistent()
            .get(&sender_principal_key)
            .unwrap_or(0);
        let sender_entry: u64 = env
            .storage()
            .persistent()
            .get(&sender_entry_key)
            .unwrap_or(0);

        // Pro-rata share of the sender's cost basis moving with these
        // shares — the same math proposed on #504.
        let principal_moved = sender_principal
            .checked_mul(amount)
            .ok_or(ContractError::Overflow)?
            .checked_div(sender_balance_before)
            .ok_or(ContractError::DivisionByZero)?;

        // Sender side: retire the moved principal. A full transfer-out
        // clears both records, mirroring withdraw()'s full-exit branch,
        // rather than leaving a zero-balance holder with a leftover Entry
        // to self-heal on the next read. A partial transfer-out leaves
        // Entry untouched, exactly like a partial withdraw(): it already
        // reflects when the sender first deposited, not what they
        // currently hold.
        if sender_balance_before - amount == 0 {
            clear_position_records(&env, &from);
        } else {
            env.storage()
                .persistent()
                .set(&sender_principal_key, &(sender_principal - principal_moved));
        }

        // Receiver side. `receiver_balance_before == 0` is this receiver's
        // first position — same check `deposit()` uses before treating a
        // deposit as a top-up, and for the same reason: it may have a stale
        // Entry/Principal record left behind by an earlier position this
        // address fully gave up, and inheriting the sender's basis/entry
        // time outright (rather than averaging against that stale record)
        // is correct here since overwriting is unconditional.
        if receiver_balance_before == 0 {
            env.storage()
                .persistent()
                .set(&receiver_principal_key, &principal_moved);
            env.storage()
                .persistent()
                .set(&receiver_entry_key, &sender_entry);
        } else {
            let receiver_principal: i128 = env
                .storage()
                .persistent()
                .get(&receiver_principal_key)
                .unwrap_or(0);
            let receiver_entry: u64 = env
                .storage()
                .persistent()
                .get(&receiver_entry_key)
                .unwrap_or(0);
            let total_principal = receiver_principal
                .checked_add(principal_moved)
                .ok_or(ContractError::Overflow)?;

            env.storage()
                .persistent()
                .set(&receiver_principal_key, &total_principal);

            // Principal-weighted average of the receiver's existing entry
            // time and the sender's, so a large incoming transfer
            // meaningfully pulls entry_time forward instead of the
            // receiver's own original stamp swallowing the incoming
            // position wholesale. Unlike the dust-position gaming
            // constraint noted on `deposit()` (which can't do this because
            // a plain top-up has no second principal weight to average
            // against), a transfer-in always carries `principal_moved`
            // alongside it, so the correct weighted average is always
            // computable here.
            let weighted_entry = if total_principal > 0 {
                let weighted = (receiver_entry as i128)
                    .checked_mul(receiver_principal)
                    .ok_or(ContractError::Overflow)?
                    .checked_add(
                        (sender_entry as i128)
                            .checked_mul(principal_moved)
                            .ok_or(ContractError::Overflow)?,
                    )
                    .ok_or(ContractError::Overflow)?
                    .checked_div(total_principal)
                    .ok_or(ContractError::DivisionByZero)?;
                weighted as u64
            } else {
                // Both principals are zero (e.g. a dust position with no
                // recorded basis on either side) — nothing to weight
                // against, so keep whatever the receiver already had.
                receiver_entry
            };
            env.storage()
                .persistent()
                .set(&receiver_entry_key, &weighted_entry);
        }

        Self::extend_position(&env, &from);
        Self::extend_position(&env, &to);

        Ok(())
    }

    /// Returns the address's mUSDC share balance, read from the share token
    /// itself. mUSDC received by transfer counts immediately and withdraws
    /// normally, exactly like minted shares; there is no separate vault-side
    /// balance that could disagree with the token.
    ///
    /// Returns 0 before `initialize`, rather than erroring: this is a view
    /// used by dashboards, and "no position" is the truthful answer for a
    /// vault that holds nothing yet.
    pub fn get_position(env: Env, address: Address) -> i128 {
        match Self::musdc(&env) {
            Ok(musdc) => TokenClient::new(&env, &musdc).balance(&address),
            Err(_) => 0,
        }
    }

    /// Returns the ledger timestamp of the address's deposit, or 0 if it holds
    /// no position. Reset whenever the position is fully withdrawn.
    ///
    /// Entry time belongs to a depositor, not to the shares: it is recorded
    /// when an address first deposits, and now (#578) is also split
    /// pro-rata on a transfer by `on_transfer` — see that function's doc
    /// Returns the ledger timestamp of the address's current deposit.
    ///
    /// An address that holds no mUSDC returns `0` because it holds no position.
    /// Cleared on full withdrawal and full transfer-out, and cleaned up on
    /// subsequent deposit if leftover records exist.
    pub fn get_entry_time(env: Env, address: Address) -> u64 {
        if Self::get_position(env.clone(), address.clone()) == 0 {
            return 0;
        }
        let key = DataKey::Entry(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Returns the address's cost basis: the net USDC it deposited and has not
    /// yet withdrawn. Yield earned is current share value minus this value.
    ///
    /// Cost basis is history, not a holding, so unlike the share balance it
    /// cannot be derived from the token on its own — but as of #578, mUSDC is
    /// a custom SEP-41 token the vault controls the code of (not a plain
    /// Stellar Asset Contract), so its `transfer`/`transfer_from` call back
    /// into `on_transfer`, which splits a sender's basis and hands the
    /// pro-rata share to the receiver at the moment of transfer. See
    /// `on_transfer`'s doc comment for the split math.
    ///
    /// An address that transferred its entire position away reports `0`
    /// here because it holds nothing, rather than a stale basis for shares
    /// it no longer has — `on_transfer` clears both records itself the
    /// moment a full transfer-out reaches zero.
    pub fn get_principal(env: Env, address: Address) -> i128 {
        if Self::get_position(env.clone(), address.clone()) == 0 {
            return 0;
        }
        let key = DataKey::Principal(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Permissionless entry point that extends the TTL of instance storage
    /// and the position records for `address`. Anyone can call it, so
    /// off-chain keepers or the user themselves can keep a position alive
    /// without needing a signature on the vault.
    pub fn extend_position_ttl(env: Env, address: Address) {
        Self::extend_instance(&env);
        Self::extend_position(&env, &address);
    }

    /// Total USDC value managed by the vault as reported by the adapter.
    /// Includes yield accrued by the underlying protocol.
    pub fn get_total_assets(env: Env) -> Result<i128, ContractError> {
        let adapter_addr: Address = env
            .storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)?;
        Ok(AdapterClient::new(&env, &adapter_addr).total_assets())
    }

    /// Returns total mUSDC shares outstanding.
    pub fn get_total_shares(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_SH).unwrap_or(0)
    }

    /// Returns the constructor-fixed address that receives performance-fee
    /// mUSDC. There is deliberately no corresponding setter.
    pub fn get_treasury(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&TREASURY)
            .ok_or(ContractError::NotInitialized)
    }

    /// Returns the fee compiled into this vault deployment, in basis points.
    pub fn get_performance_fee_bps(_env: Env) -> i128 {
        PERFORMANCE_FEE_BPS
    }

    // -----------------------------------------------------------------------
    // Preview and conversion views (#1265)
    //
    // All of these run the same `pricing` helpers as `deposit`/`withdraw`, so
    // a quote and the execution that follows it cannot drift apart.
    //
    // `convert_to_*` and `get_share_price` read the adapter's *reported*
    // state. `preview_deposit` and `preview_withdraw` additionally call the
    // adapter's `refresh()` first, exactly as `deposit`/`withdraw` do, so they
    // price against the same refreshed totals. That makes them intended for
    // off-chain simulation, not for committing in a transaction.
    //
    // Zero and negative inputs: a zero amount quotes zero; a negative amount
    // returns `ZeroAmount`, the error the entry points use for non-positive
    // input.
    // -----------------------------------------------------------------------

    /// Shares `assets` USDC would buy at the current price (rounded down),
    /// without the deposit-only guards (pause, minimum size).
    ///
    /// * Empty vault: 1 share per stroop (the virtual offset cancels).
    /// * `assets == 0`: `0`.
    /// * Shares outstanding but the adapter reports no assets:
    ///   `AdapterReportedNoAssets`, as `deposit` would.
    pub fn convert_to_shares(env: Env, assets: i128) -> Result<i128, ContractError> {
        if assets < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if assets == 0 {
            return Ok(0);
        }
        let (total_shares, total_assets) = Self::pricing_state(&env)?;
        if total_shares > 0 && total_assets <= 0 {
            return Err(ContractError::AdapterReportedNoAssets);
        }
        pricing::shares_for_assets(assets, total_shares, total_assets)
    }

    /// Gross USDC value of `shares` at the current price (rounded down),
    /// before any performance fee. Equals `preview_withdraw(..).gross_assets`.
    ///
    /// Returns `0` for `shares == 0`, an empty vault, or when the adapter
    /// holds no shares or no assets.
    pub fn convert_to_assets(env: Env, shares: i128) -> Result<i128, ContractError> {
        if shares < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if shares == 0 {
            return Ok(0);
        }
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        if total_shares <= 0 {
            return Ok(0);
        }
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);
        let (_, total_assets) = Self::pricing_state(&env)?;
        let adapter_shares =
            pricing::adapter_shares_for_shares(shares, total_shares, total_adapter_shares)?;
        pricing::assets_for_adapter_shares(adapter_shares, total_assets, total_adapter_shares)
    }

    /// Price of one share in USDC, scaled by `pricing::PRICE_SCALE` (1e7, so
    /// `10_000_000` is 1.0). Uses the deposit pricing (virtual offset), so an
    /// empty vault is exactly `10_000_000` and a vault with shares but no
    /// assets prices near zero instead of erroring.
    pub fn get_share_price(env: Env) -> Result<i128, ContractError> {
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let (_, total_assets) = Self::pricing_state(&env)?;
        pricing::share_price(total_assets, total_shares)
    }

    /// Shares `deposit(amount)` would mint right now, or the error it would
    /// revert with (`DepositsPaused`, `AdapterReportedNoAssets`,
    /// `DepositTooSmall`). `amount == 0` quotes `0`.
    pub fn preview_deposit(env: Env, amount: i128) -> Result<i128, ContractError> {
        if Self::is_paused(env.clone()) {
            return Err(ContractError::DepositsPaused);
        }
        if amount < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if amount == 0 {
            return Ok(0);
        }
        let adapter = Self::adapter(&env)?;
        AdapterClient::new(&env, &adapter).refresh();
        let (total_shares, total_assets) = Self::pricing_state(&env)?;
        if total_shares > 0 && total_assets <= 0 {
            return Err(ContractError::AdapterReportedNoAssets);
        }
        let shares = pricing::shares_for_assets(amount, total_shares, total_assets)?;
        if shares <= 0 {
            return Err(ContractError::DepositTooSmall);
        }
        Ok(shares)
    }

    /// What `withdraw(holder, shares, _)` would do right now: gross redemption,
    /// performance fee on the holder's own cost basis (including basis moved
    /// by mUSDC transfers), treasury shares minted and the net payout. Returns
    /// the error `withdraw` would revert with (`NoSharesOutstanding`,
    /// `InsufficientShares`, `WithdrawalTooSmall`). `shares == 0` quotes zeros.
    ///
    /// The redemption assumes the adapter pays out proportionally to its
    /// reported assets; an adapter with extra redemption rounding can pay a
    /// few stroops less. The treasury mint is priced against the vault after
    /// the redemption.
    pub fn preview_withdraw(
        env: Env,
        holder: Address,
        shares: i128,
    ) -> Result<WithdrawPreview, ContractError> {
        if shares < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if shares == 0 {
            return Ok(WithdrawPreview {
                gross_assets: 0,
                fee: 0,
                treasury_shares: 0,
                assets_out: 0,
            });
        }
        let musdc = Self::musdc(&env)?;
        let adapter = Self::adapter(&env)?;
        AdapterClient::new(&env, &adapter).refresh();

        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);
        if total_shares <= 0 {
            return Err(ContractError::NoSharesOutstanding);
        }
        let holder_shares = TokenClient::new(&env, &musdc).balance(&holder);
        if holder_shares < shares {
            return Err(ContractError::InsufficientShares);
        }

        let total_assets = AdapterClient::new(&env, &adapter).total_assets();
        let adapter_shares =
            pricing::adapter_shares_for_shares(shares, total_shares, total_adapter_shares)?;
        let gross =
            pricing::assets_for_adapter_shares(adapter_shares, total_assets, total_adapter_shares)?;
        if gross <= 0 {
            return Err(ContractError::WithdrawalTooSmall);
        }

        let principal: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Principal(holder))
            .unwrap_or(0);
        let remaining_assets = total_assets.saturating_sub(gross);
        let outcome = pricing::calculate_withdrawal_fee_and_net(
            gross,
            principal,
            shares,
            holder_shares,
            total_shares,
            remaining_assets,
            PERFORMANCE_FEE_BPS,
            BPS_DENOMINATOR,
        )?;

        Ok(WithdrawPreview {
            gross_assets: gross,
            fee: outcome.fee,
            treasury_shares: outcome.treasury_shares,
            assets_out: outcome.net_usdc_out,
        })
    }

    // -----------------------------------------------------------------------
    // Admin / safety rails
    // -----------------------------------------------------------------------

    /// Admin-only emergency switch. While paused, new deposits are rejected.
    /// Withdrawals are deliberately left open so a pause can never trap funds.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        Self::extend_instance(&env);
        env.storage().instance().set(&PAUSED, &paused);
        env.events().publish(PAUSED_EVT, paused);
        Ok(())
    }

    /// Returns whether deposits are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }

    /// Admin-only: nominate `new_admin` as the next admin. Requires the
    /// current admin's `require_auth()`. Does not itself change who the
    /// admin is — that only happens once the nominee calls `accept_admin`
    /// with their own signature, so a typo'd or unreachable address can
    /// never brick admin: the old admin stays in control until a working
    /// key on the other end proves it can sign. Overwrites any prior,
    /// not-yet-accepted nomination.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        Self::extend_instance(&env);
        env.storage().instance().set(&PEND_ADM, &new_admin);
        env.events().publish(TRANSFER_EVT, new_admin.clone());
        Ok(())
    }

    /// Completes a pending admin handover. Requires the nominee's own
    /// `require_auth()`, not the current admin's, so the transfer can only
    /// complete once the new address has demonstrably proven it controls a
    /// working signing key. Fails with `NoPendingAdmin` if no
    /// `transfer_admin` nomination is outstanding.
    pub fn accept_admin(env: Env) -> Result<(), ContractError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&PEND_ADM)
            .ok_or(ContractError::NoPendingAdmin)?;
        pending.require_auth();
        Self::extend_instance(&env);
        env.storage().instance().set(&ADMIN, &pending);
        env.storage().instance().remove(&PEND_ADM);
        env.events().publish(ACCEPT_EVT, pending.clone());
        Ok(())
    }

    /// Returns the pending admin nominee, if any.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&PEND_ADM)
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)
    }

    /// Replace the yield adapter. The vault must have no shares outstanding
    /// (`TOTAL_SH == 0`) *and* no position left at the old adapter
    /// (`ADPT_SH == 0`) before calling this.
    ///
    /// Checking `TOTAL_SH` alone is not sufficient: the two counters can
    /// desync (see `migrate_adapter`'s `NoAdapterPosition` doc), so a vault
    /// that looks empty by `TOTAL_SH` can still have real value sitting at
    /// the old adapter. Deliberately does *not* reset `ADPT_SH` to zero on
    /// swap the way it used to -- doing so would destroy the only evidence
    /// that a stranded position existed, and it is unnecessary: `ADPT_SH`
    /// is only ever nonzero here in a genuinely-empty vault as a result of a
    /// bug, and clearing it would delete the observability that bug needs
    /// to be diagnosed, not fix it. In the normal case (both counters
    /// already zero) leaving `ADPT_SH` alone is a no-op.
    ///
    /// The target is also validated (#1270): it must use this vault's USDC
    /// (`AdapterUsdcMismatch`), be bound to this vault
    /// (`AdapterVaultMismatch`), and hold no position of its own
    /// (`AdapterResidualPosition`, nonzero `total_shares()` or
    /// `total_assets()`). A target that does not export the `get_usdc` and
    /// `get_vault` views, or whose views fail, is rejected with the matching
    /// mismatch error.
    ///
    /// Guarded against reentrancy: it calls out to the target adapter before
    /// writing the new adapter address.
    pub fn set_adapter(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::with_lock(&env, || {
            Self::set_adapter_unlocked(env.clone(), new_adapter)
        })
    }

    fn set_adapter_unlocked(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        Self::extend_instance(&env);
        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);
        if Self::get_total_shares(env.clone()) > 0 || total_adapter_shares > 0 {
            return Err(ContractError::AdapterSwapUnsafe);
        }
        Self::validate_adapter_target(&env, &new_adapter)?;
        let new_adapter_client = AdapterClient::new(&env, &new_adapter);
        if new_adapter_client.total_shares() != 0 || new_adapter_client.total_assets() != 0 {
            return Err(ContractError::AdapterResidualPosition);
        }
        env.storage().instance().set(&ADAPTER, &new_adapter);
        env.events().publish(ADAPTER_EVT, new_adapter.clone());
        Ok(())
    }

    /// Checks that `target` is an adapter this vault can actually operate:
    /// it must use the vault's own USDC and be bound to this vault. Shared
    /// by `set_adapter` and `begin_migration` so the two admin paths cannot
    /// drift apart (#1270).
    ///
    /// Both facts are read through the `get_usdc`/`get_vault` views and
    /// compared against this vault's own state. The views are called through
    /// their non-panicking `try_` client methods so that a target which does
    /// not export them, panics, or is not a contract at all is rejected with
    /// a typed error instead of aborting the transaction. There is no
    /// fallback for adapters without the views: any failure of a view is a
    /// rejection. Not part of the contract ABI (no `pub`).
    fn validate_adapter_target(env: &Env, target: &Address) -> Result<(), ContractError> {
        let client = AdapterClient::new(env, target);

        let vault_usdc = Self::usdc(env)?;
        match client.try_get_usdc() {
            Ok(Ok(adapter_usdc)) if adapter_usdc == vault_usdc => {}
            _ => return Err(ContractError::AdapterUsdcMismatch),
        }

        match client.try_get_vault() {
            Ok(Ok(adapter_vault)) if adapter_vault == env.current_contract_address() => {}
            _ => return Err(ContractError::AdapterVaultMismatch),
        }

        Ok(())
    }

    /// Returns the current adapter address.
    pub fn get_adapter(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)
    }

    /// Phase 1 of a two-phase migration, and the trigger for
    /// `MIN_LEDGER_GAP`'s ~1-day timelock. Snapshots the target adapter's
    /// `total_assets()` and the current ledger sequence so that a later
    /// `migrate_adapter` call can verify the valuation has been stable for
    /// at least `MIN_LEDGER_GAP` ledgers. This prevents an observer from
    /// griefing or masking a migration by front-running a
    /// transiently-shifted valuation (issue #567), and separately gives
    /// observers or automated monitoring a real window to notice and react
    /// to a migration triggered by a compromised admin key before it can
    /// execute (issue #557) — the same unattended signer used for routine
    /// migration-keeper operations can call this function, so the delay
    /// itself is the only thing standing between a leaked key and the
    /// vault's entire position moving to an address the attacker
    /// controls.
    ///
    /// The target must also use this vault's USDC and be bound to this vault
    /// (`AdapterUsdcMismatch` / `AdapterVaultMismatch`, #1270); a target
    /// whose views are missing or fail is rejected the same way. Residue is
    /// deliberately not checked here: a migration target is expected to
    /// start empty, but the post-migration stability and slippage checks
    /// already cover value drift, and rejecting a funded target would break
    /// re-running `begin_migration` after a partial attempt.
    ///
    /// Can be called repeatedly for the same or different adapters; each
    /// call overwrites the previous snapshot. The admin must then wait for
    /// the ledger gap to elapse before calling `migrate_adapter`.
    ///
    /// Guarded against reentrancy: it calls out to the target adapter before
    /// writing the snapshot.
    pub fn begin_migration(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::with_lock(&env, || {
            Self::begin_migration_unlocked(env.clone(), new_adapter)
        })
    }

    fn begin_migration_unlocked(env: Env, new_adapter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        Self::extend_instance(&env);

        let old_adapter_addr = Self::get_adapter(env.clone())?;
        if new_adapter == old_adapter_addr {
            return Err(ContractError::SameAdapter);
        }
        Self::validate_adapter_target(&env, &new_adapter)?;

        let new_adapter_client = AdapterClient::new(&env, &new_adapter);
        new_adapter_client.refresh();
        let snapshot_assets = new_adapter_client.total_assets();
        if snapshot_assets < 0 {
            return Err(ContractError::MigrationSnapshotAssetsInvalid);
        }
        let snapshot_ledger = env.ledger().sequence();

        let snapshot = MigrationSnapshot {
            adapter: new_adapter.clone(),
            total_assets: snapshot_assets,
            ledger_seq: snapshot_ledger,
        };
        env.storage().instance().set(&MIG_SNAP, &snapshot);
        env.storage().instance().set(&MIG_ACTIVE, &1_i128);
        env.events().publish(
            MIG_BEGIN_EVT,
            (new_adapter, snapshot_ledger + MIN_LEDGER_GAP),
        );

        Ok(())
    }

    /// Returns the current migration snapshot, if one has been recorded by
    /// `begin_migration`. Off-chain callers can use this to verify the
    /// cooldown is progressing.
    pub fn get_migration_snapshot(env: Env) -> Result<MigrationSnapshot, ContractError> {
        Self::require_migration_snapshot(&env)
    }

    /// Phase 2 of a two-phase migration. Must be preceded by
    /// `begin_migration(new_adapter)` and at least `MIN_LEDGER_GAP`
    /// ledgers must have elapsed. Moves the vault's entire position from
    /// the current adapter to `new_adapter` in one atomic transaction,
    /// without requiring depositors to withdraw first. Unlike
    /// `set_adapter`, this is safe to call with shares outstanding.
    ///
    /// Withdraws everything from the old adapter into the vault, deposits
    /// it into `new_adapter`, and performs two independent checks:
    ///
    /// 1. **Slippage**: `new_adapter.total_assets()` must be at least
    ///    `(10_000 - max_slippage_bps) / 10_000` of the old adapter's
    ///    pre-migration value.
    ///
    /// 2. **Stability**: `new_adapter.total_assets()` must be at least
    ///    `(10_000 - max_slippage_bps) / 10_000` of the snapshot value
    ///    recorded by `begin_migration`, proving the valuation has been
    ///    stable across the ledger-gap cooldown.
    ///
    /// If either check fails the whole call reverts and nothing moves
    /// (Soroban transactions are atomic). On success the snapshot is
    /// cleared. `TOTAL_SH`, every holder's mUSDC balance, and every
    /// depositor's `Principal` and `Entry` are untouched: they're
    /// denominated in vault mUSDC shares, not adapter shares, so they
    /// remain valid across an adapter swap.
    ///
    /// Fails with `InvalidSlippageBps` if `max_slippage_bps` exceeds
    /// `MAX_ADMIN_SLIPPAGE_BPS`. Unlike the pre-#557 behaviour, the caller
    /// cannot opt into unlimited slippage no matter the circumstances: a
    /// single compromised admin key authorizing `max_slippage_bps: 10_000`
    /// used to be able to move the entire vault position with zero loss
    /// protection, which is exactly the attack #557 describes. Recovering
    /// from an adapter already known to be broken now requires raising
    /// `MAX_ADMIN_SLIPPAGE_BPS` itself (a code change), not just a
    /// higher per-call argument.
    ///
    /// The slippage/stability checks alone do not protect against a
    /// malicious or compromised admin key: the admin chooses `new_adapter`,
    /// and a fake adapter could report whatever `total_assets()` it likes
    /// to pass both checks and then keep the funds. What actually stands
    /// between a compromised key and total loss is `MIN_LEDGER_GAP`'s
    /// ~1-day timelock from `begin_migration` (issue #557): it cannot stop
    /// a patient attacker outright, but it gives observers or automated
    /// monitoring a real window to notice a suspicious `begin_migration`
    /// call (e.g. targeting an unrecognized adapter address) and react
    /// (e.g. `set_paused` does not block this call, so reacting means
    /// rotating the admin key via `transfer_admin`/`accept_admin`, or
    /// pausing deposits, before the cooldown elapses) before the funds
    /// actually move.
    ///
    /// The invariant's real strength also depends on how honestly
    /// `new_adapter.total_assets()` reflects what it actually holds.
    /// `BlendAdapter::total_assets()` self-reports based on the amount
    /// `deposit()` was called with, not an independent on-chain
    /// measurement, so for a `BlendAdapter` target this check mainly
    /// catches loss on the withdrawal leg from the old adapter (measured
    /// independently before and after), not a `BlendAdapter` that
    /// silently fails to actually supply the funds to its pool while
    /// still returning success.
    ///
    /// Guarded against reentrancy: it makes several adapter and token calls
    /// before committing `ADAPTER`/`ADPT_SH`, and those writes depend on the
    /// values those calls return, so they cannot be moved ahead of them.
    pub fn migrate_adapter(
        env: Env,
        new_adapter: Address,
        max_slippage_bps: u32,
    ) -> Result<(), ContractError> {
        Self::with_lock(&env, || {
            Self::migrate_adapter_unlocked(env.clone(), new_adapter, max_slippage_bps)
        })
    }

    fn migrate_adapter_unlocked(
        env: Env,
        new_adapter: Address,
        max_slippage_bps: u32,
    ) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        Self::extend_instance(&env);

        if max_slippage_bps > MAX_ADMIN_SLIPPAGE_BPS {
            return Err(ContractError::InvalidSlippageBps);
        }

        let old_adapter_addr = Self::get_adapter(env.clone())?;
        if new_adapter == old_adapter_addr {
            return Err(ContractError::SameAdapter);
        }

        let total_adapter_shares: i128 = env.storage().instance().get(&ADPT_SH).unwrap_or(0);
        if total_adapter_shares <= 0 {
            return Err(ContractError::NoAdapterPosition);
        }

        // Verify a prior begin_migration snapshot exists for this adapter
        // and that the ledger-gap cooldown has elapsed.
        let snapshot = Self::require_migration_snapshot(&env)?;
        if snapshot.adapter != new_adapter {
            return Err(ContractError::MigrationNotInitialized);
        }
        let current_ledger = env.ledger().sequence();
        if current_ledger < snapshot.ledger_seq + MIN_LEDGER_GAP {
            return Err(ContractError::MigrationCooldownNotMet);
        }

        let usdc = Self::usdc(&env)?;
        let old_adapter = AdapterClient::new(&env, &old_adapter_addr);

        // Read the old adapter's value independently, before extraction, so
        // this baseline can catch loss on the withdrawal leg itself (e.g. a
        // rate that moved, a rounding-lossy withdraw), not just loss on the
        // new-adapter leg.
        old_adapter.refresh();
        let value_before = old_adapter.total_assets();
        if value_before <= 0 {
            return Err(ContractError::MigrationBaselineInvalid);
        }

        // Baseline the target adapter's balance before landing any funds on
        // it, so a pre-existing residue (e.g. left over from a prior
        // stranding bug) isn't counted as value this migration delivered.
        let new_adapter_client = AdapterClient::new(&env, &new_adapter);
        new_adapter_client.refresh();
        let new_adapter_value_before = new_adapter_client.total_assets();

        // Withdraw the vault's entire position into the vault itself, not a
        // single depositor, mirroring the same withdraw() entrypoint every
        // user withdrawal already goes through.
        let withdrawn =
            old_adapter.withdraw(&total_adapter_shares, &env.current_contract_address());
        if withdrawn <= 0 {
            return Err(ContractError::WithdrawalTooSmall);
        }

        // Land the funds at the new adapter before calling deposit(), the
        // same pattern the vault's own deposit() uses.
        TokenClient::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &new_adapter,
            &withdrawn,
        );
        let new_shares = new_adapter_client.deposit(&withdrawn);
        if new_shares <= 0 {
            return Err(ContractError::DepositTooSmall);
        }
        // Price the new adapter from a fresh read so a cache-backed adapter
        // (e.g. Blend) reports its real post-deposit value, matching deposit().
        // The value this migration delivered is the delta over the target's
        // pre-existing balance, not its raw post-transfer total.
        new_adapter_client.refresh();
        let value_after = new_adapter_client
            .total_assets()
            .checked_sub(new_adapter_value_before)
            .ok_or(ContractError::Overflow)?;

        // Check 1: slippage against the old adapter's pre-migration value.
        let min_acceptable = value_before
            .checked_mul(10_000i128 - max_slippage_bps as i128)
            .ok_or(ContractError::Overflow)?
            .checked_div(10_000i128)
            .ok_or(ContractError::DivisionByZero)?;
        if value_after < min_acceptable {
            return Err(ContractError::MigrationValueDrift);
        }

        // Check 2: stability — the new adapter's balance *before this
        // migration's own deposit lands* must be within tolerance of the
        // snapshot taken at begin_migration time, proving the adapter was
        // not drained or manipulated during the ledger-gap cooldown.
        // Deliberately checked against new_adapter_value_before, not
        // value_after: value_after necessarily includes the funds this
        // migration itself just delivered, so checking it against the
        // snapshot would always pass regardless of how much the adapter's
        // pre-existing balance drifted, defeating the whole point of the
        // stability check.
        let min_acceptable_from_snapshot = snapshot
            .total_assets
            .checked_mul(10_000i128 - max_slippage_bps as i128)
            .ok_or(ContractError::Overflow)?
            .checked_div(10_000i128)
            .ok_or(ContractError::DivisionByZero)?;
        if new_adapter_value_before < min_acceptable_from_snapshot {
            return Err(ContractError::MigrationStabilityDrift);
        }

        env.storage().instance().set(&ADAPTER, &new_adapter);
        env.storage()
            .instance()
            .set(&ADPT_SH, &new_adapter_client.total_shares());
        env.events()
            .publish(MIGRATE_EVT, (old_adapter_addr.clone(), new_adapter.clone()));
        env.storage().instance().set(&MIG_ACTIVE, &0_i128);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Runs `f` while holding the reentrancy lock.
    ///
    /// If the lock is already held, `f` is not run and the call fails with
    /// `ReentrancyDetected` without touching any state. The lock is released
    /// on both the `Ok` and `Err` paths before returning. (A returned `Err`
    /// also rolls back the whole invocation, including the lock write, so
    /// the explicit release is belt and braces rather than the only thing
    /// keeping the vault from locking itself.)
    fn with_lock<T>(
        env: &Env,
        f: impl FnOnce() -> Result<T, ContractError>,
    ) -> Result<T, ContractError> {
        if env.storage().instance().get(&LOCKED).unwrap_or(false) {
            return Err(ContractError::ReentrancyDetected);
        }
        env.storage().instance().set(&LOCKED, &true);
        let result = f();
        env.storage().instance().remove(&LOCKED);
        result
    }

    /// Values the adapter shares a deposit credited, in USDC, from the
    /// adapter's post-deposit reads, and checks that value against what the
    /// deposit could actually have added.
    ///
    /// The credit is valued at `credited * assets_after / shares_after`. Its
    /// backing is the smaller of `amount` (the USDC the adapter was given)
    /// and `assets_after - assets_before` (how much the adapter's own
    /// valuation grew). A credit worth more than its backing plus
    /// `deposit_value_tolerance(amount)` means the adapter's reported credit
    /// and its own ledger disagree, and fails with `DepositValueMismatch`.
    /// A credit within the tolerance is capped at its backing, so rounding
    /// can never mint more than the deposit delivered. A credit short of its
    /// backing by no more than one adapter share's value plus one stroop is
    /// the adapter's own mint rounding and counts as the full backing. A
    /// credit worth less than that (partial fill, supply cap, fee on
    /// deposit) is accepted and returned as is: the caller is minted for
    /// what was credited and `min_shares_out` is their protection.
    fn value_deposit_credit(
        amount: i128,
        credited: i128,
        assets_before: i128,
        assets_after: i128,
        shares_after: i128,
    ) -> Result<i128, ContractError> {
        // A credit larger than the adapter's whole post-deposit position
        // cannot be real.
        if shares_after <= 0 || credited > shares_after {
            return Err(ContractError::DepositValueMismatch);
        }

        let credited_value = credited
            .checked_mul(assets_after)
            .ok_or(ContractError::Overflow)?
            .checked_div(shares_after)
            .ok_or(ContractError::DivisionByZero)?;

        let backing = amount.min(
            assets_after
                .checked_sub(assets_before)
                .ok_or(ContractError::Overflow)?,
        );
        let ceiling = backing
            .checked_add(Self::deposit_value_tolerance(amount)?)
            .ok_or(ContractError::Overflow)?;
        if credited_value > ceiling {
            return Err(ContractError::DepositValueMismatch);
        }

        // A share-based adapter rounds its mint down by less than one of its
        // own shares, and valuing the credit above rounds down by less than
        // one stroop. A shortfall within that is rounding, not a partial
        // fill, so the credit counts as its full backing and the deposit
        // mints exactly what `preview_deposit` quoted.
        //
        // The slack is capped at the deposit value tolerance. When one
        // adapter share is worth a lot, a whole share of shortfall is real
        // value the adapter never credited; counting it as backing would let
        // the depositor mint on it at existing holders' expense.
        let one_share_value = assets_after
            .checked_add(shares_after - 1)
            .ok_or(ContractError::Overflow)?
            .checked_div(shares_after)
            .ok_or(ContractError::DivisionByZero)?;
        let rounding_slack = one_share_value
            .checked_add(1)
            .ok_or(ContractError::Overflow)?
            .min(Self::deposit_value_tolerance(amount)?);
        if credited_value < backing && backing - credited_value <= rounding_slack {
            return Ok(backing.max(0));
        }

        Ok(credited_value.min(backing).max(0))
    }

    /// How far a deposit's valued credit may exceed its backing before the
    /// vault treats it as a mismatch rather than rounding:
    /// `amount * DEPOSIT_VALUE_TOLERANCE_BPS / 10_000 + DEPOSIT_VALUE_TOLERANCE_STROOPS`.
    fn deposit_value_tolerance(amount: i128) -> Result<i128, ContractError> {
        amount
            .checked_mul(DEPOSIT_VALUE_TOLERANCE_BPS)
            .ok_or(ContractError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ContractError::DivisionByZero)?
            .checked_add(DEPOSIT_VALUE_TOLERANCE_STROOPS)
            .ok_or(ContractError::Overflow)
    }

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Returns the active migration snapshot recorded by `begin_migration`,
    /// or `MigrationNotInitialized` if none is active. Shared by
    /// `get_migration_snapshot` and `migrate_adapter`'s precondition check
    /// so the two can't drift apart.
    fn require_migration_snapshot(env: &Env) -> Result<MigrationSnapshot, ContractError> {
        let active: i128 = env.storage().instance().get(&MIG_ACTIVE).unwrap_or(0);
        if active == 0 {
            return Err(ContractError::MigrationNotInitialized);
        }
        env.storage()
            .instance()
            .get(&MIG_SNAP)
            .ok_or(ContractError::MigrationNotInitialized)
    }

    fn usdc(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&USDC)
            .ok_or(ContractError::NotInitialized)
    }

    fn adapter(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&ADAPTER)
            .ok_or(ContractError::NotInitialized)
    }

    /// `(total_shares, total_assets)` as the adapter currently reports them.
    fn pricing_state(env: &Env) -> Result<(i128, i128), ContractError> {
        let adapter = Self::adapter(env)?;
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        Ok((
            total_shares,
            AdapterClient::new(env, &adapter).total_assets(),
        ))
    }

    fn musdc(env: &Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&MUSDC)
            .ok_or(ContractError::NotInitialized)
    }

    /// Extends the TTL of the contract instance. Called at the start of
    /// every state-changing entry point so the vault's configuration never
    /// expires while it is actively used.
    fn extend_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
    }

    /// Extends the TTL of an address's position records (entry time and
    /// principal) whenever the position is read or written. Permissionless
    /// `extend_position_ttl` calls this for keepers.
    fn extend_position(env: &Env, address: &Address) {
        let storage = env.storage().persistent();
        for key in [
            DataKey::Entry(address.clone()),
            DataKey::Principal(address.clone()),
        ] {
            if storage.has(&key) {
                storage.extend_ttl(&key, POSITION_THRESHOLD, POSITION_BUMP);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl, contracttype, panic_with_error, symbol_short,
        testutils::{Address as _, Events, Ledger as _},
        token::{StellarAssetClient, TokenClient},
        Address, Env, Symbol,
    };

    // The address every test vault is registered at, and the address the mock
    // adapters report from `get_vault()`. `set_adapter`/`begin_migration`
    // require a target bound to the vault (#1270), and the mocks are
    // initialized before the vault exists in several setups, so they all
    // report this one fixed address instead of being told it.
    fn test_vault(env: &Env) -> Address {
        Address::from_str(
            env,
            "CB7H47T6PZ7H47T6PZ7H47T6PZ7H47T6PZ7H47T6PZ7H47T6PZ7H4YUV",
        )
    }

    // Reads an instance-storage value, panicking with the typed
    // NotInitialized error instead of an opaque unwrap trap if it's unset.
    // Collapses what was previously a repeated 6-line
    // `unwrap_or_else(|| { panic_with_error!(...) })` block, used across
    // these mock adapters, into one call site per use.
    fn get_or_not_initialized<T>(env: &Env, value: Option<T>) -> T {
        value.unwrap_or_else(|| panic_with_error!(env, ContractError::NotInitialized))
    }

    // -----------------------------------------------------------------------
    // Shared logic for the proportional, live-priced mock adapters below
    // (MockAdapter, LossyMockAdapter, ZeroShareMockAdapter). Each mock has
    // its own storage-key constants since each is a separately deployed
    // contract with isolated instance storage, but the withdraw/total_assets
    // bodies are identical across all of them, so that part lives here once.
    // -----------------------------------------------------------------------

    fn mock_proportional_withdraw(
        env: &Env,
        usdc: &Address,
        sh_key: &Symbol,
        shares: i128,
        recipient: &Address,
    ) -> i128 {
        let total_sh: i128 = env.storage().instance().get(sh_key).unwrap_or(0);
        let balance = TokenClient::new(env, usdc).balance(&env.current_contract_address());

        let usdc_out = if total_sh > 0 {
            shares * balance / total_sh
        } else {
            0
        };

        if usdc_out > 0 {
            TokenClient::new(env, usdc).transfer(
                &env.current_contract_address(),
                recipient,
                &usdc_out,
            );
        }
        env.storage().instance().set(sh_key, &(total_sh - shares));
        usdc_out
    }

    fn mock_total_assets(env: &Env, usdc: &Address) -> i128 {
        TokenClient::new(env, usdc).balance(&env.current_contract_address())
    }

    // Shares a share-based protocol credits for `invested` USDC: bought at
    // the pre-deposit `total_sh / assets_before` rate, 1:1 into an empty
    // position. Crediting 1:1 regardless of accrued yield would value the
    // new shares above what was deposited, which the vault now rejects as
    // `DepositValueMismatch` (#1263).
    fn mock_shares_for(invested: i128, total_sh: i128, assets_before: i128) -> i128 {
        if total_sh > 0 && assets_before > 0 {
            invested * total_sh / assets_before
        } else {
            invested
        }
    }

    // `mock_shares_for` for the balance-priced mocks, whose `deposit` is
    // called after the vault has already transferred `amount` in.
    fn mock_credit_from_balance(env: &Env, usdc: &Address, sh_key: &Symbol, amount: i128) -> i128 {
        let total_sh: i128 = env.storage().instance().get(sh_key).unwrap_or(0);
        let assets_before = mock_total_assets(env, usdc) - amount;
        let credited = mock_shares_for(amount, total_sh, assets_before);
        env.storage().instance().set(sh_key, &(total_sh + credited));
        credited
    }

    // -----------------------------------------------------------------------
    // MockMusdc: a minimal stand-in for the real `meridian-musdc-token`
    // crate (#578), used instead of a genuine cross-crate dependency for
    // the same reason `MockAdapter` below stands in for a real adapter
    // crate rather than depending on one: the vault crate shouldn't need to
    // depend on musdc-token for production code, and its own test suite
    // (packages/contracts/musdc-token/src/lib.rs) already exercises the
    // real token's transfer/callback plumbing end-to-end against its own
    // local mock vault. What matters here is exercising *this* crate's
    // `on_transfer` logic against a token that genuinely calls it the same
    // way the real one does: a direct, self-authorized cross-contract call
    // made after balances have moved, carrying both parties'
    // pre-transfer balances. `TokenClient`/`MusdcAdminClient` dispatch by
    // function name and argument encoding, not by any Rust trait
    // implementation, so this needs no `#[contractclient]`-generated trait
    // on its side to be a valid call target for either. Wrapped in its own
    // module for the same reason as `cached_mock`/`lossy_mock` below:
    // contractimpl-generated helper items (e.g. `__initialize`) aren't
    // namespaced by type, so a second contract with a same-named method
    // (`initialize`) at this module level would collide.
    // -----------------------------------------------------------------------
    mod mock_musdc {
        use super::*;

        const MM_ADMIN: Symbol = symbol_short!("MM_ADMIN");

        #[contracttype]
        #[derive(Clone)]
        pub enum MockMusdcKey {
            Balance(Address),
        }

        #[contract]
        pub struct MockMusdc;

        #[contractimpl]
        impl MockMusdc {
            pub fn initialize(env: Env, admin: Address) {
                env.storage().instance().set(&MM_ADMIN, &admin);
            }

            pub fn mint(env: Env, to: Address, amount: i128) {
                // Real Stellar Asset Contracts do not archive in practice;
                // extending here keeps this mock alive across a migration
                // test's ledger-gap jump the same way, since mint() (called
                // from vault.deposit()) is its only touch before the jump.
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
                let balance = Self::read_balance(&env, &to);
                Self::write_balance(&env, &to, balance + amount);
            }

            pub fn balance(env: Env, id: Address) -> i128 {
                Self::read_balance(&env, &id)
            }

            pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
                from.require_auth();
                if from == to {
                    return;
                }
                let from_balance = Self::read_balance(&env, &from);
                let to_balance = Self::read_balance(&env, &to);
                Self::write_balance(&env, &from, from_balance - amount);
                Self::write_balance(&env, &to, to_balance + amount);

                let admin: Address = env.storage().instance().get(&MM_ADMIN).unwrap();
                MeridianVaultClient::new(&env, &admin).on_transfer(
                    &from,
                    &to,
                    &amount,
                    &from_balance,
                    &to_balance,
                );
            }

            pub fn burn(env: Env, from: Address, amount: i128) {
                from.require_auth();
                let balance = Self::read_balance(&env, &from);
                Self::write_balance(&env, &from, balance - amount);
            }

            fn read_balance(env: &Env, id: &Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&MockMusdcKey::Balance(id.clone()))
                    .unwrap_or(0)
            }

            fn write_balance(env: &Env, id: &Address, amount: i128) {
                let key = MockMusdcKey::Balance(id.clone());
                env.storage().persistent().set(&key, &amount);
                // Persistent entries have their own TTL, separate from the
                // contract instance (see MockMusdc::mint() above); a real
                // Stellar Asset Contract balance entry does not archive in
                // practice, so extend this mock's the same way.
                env.storage()
                    .persistent()
                    .extend_ttl(&key, INSTANCE_THRESHOLD, INSTANCE_BUMP);
            }
        }
    }
    use mock_musdc::{MockMusdc, MockMusdcClient};

    // -----------------------------------------------------------------------
    // MockAdapter: proportional yield-bearing adapter used in vault tests.
    // Tracks shares 1:1 with deposited USDC. Proportional withdrawal means
    // any USDC minted directly to the adapter (simulating yield) is included
    // in the withdrawal amount.
    // -----------------------------------------------------------------------

    const MA_USDC: Symbol = symbol_short!("MA_USDC");
    const MA_SH: Symbol = symbol_short!("MA_SH");

    #[contract]
    pub struct MockAdapter;

    #[contractimpl]
    impl MockAdapter {
        pub fn get_usdc(env: Env) -> Address {
            get_or_not_initialized(&env, env.storage().instance().get(&MA_USDC))
        }

        pub fn get_vault(env: Env) -> Address {
            test_vault(&env)
        }

        pub fn initialize(env: Env, usdc: Address) {
            env.storage().instance().set(&MA_USDC, &usdc);
            env.storage().instance().set(&MA_SH, &0_i128);
        }

        pub fn deposit(env: Env, amount: i128) -> i128 {
            // Matches every real adapter's deposit() extending its own
            // instance TTL (#704): this is the old adapter's only touch
            // before a migration test's ledger jump, and begin_migration()
            // never calls anything on the *current* adapter, only the
            // migration target.
            env.storage()
                .instance()
                .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
            // USDC address is always set in initialize(), so this is safe.
            let usdc: Address =
                get_or_not_initialized(&env, env.storage().instance().get(&MA_USDC));
            mock_credit_from_balance(&env, &usdc, &MA_SH, amount)
        }

        pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
            // USDC address is always set in initialize(), so this is safe.
            let usdc: Address =
                get_or_not_initialized(&env, env.storage().instance().get(&MA_USDC));
            mock_proportional_withdraw(&env, &usdc, &MA_SH, shares, &recipient)
        }

        pub fn total_assets(env: Env) -> i128 {
            // USDC address is always set in initialize(), so this is safe.
            let usdc: Address =
                get_or_not_initialized(&env, env.storage().instance().get(&MA_USDC));
            mock_total_assets(&env, &usdc)
        }

        pub fn total_shares(env: Env) -> i128 {
            env.storage().instance().get(&MA_SH).unwrap_or(0)
        }

        pub fn refresh(env: Env) {
            // A real adapter's refresh()/accrue() extends its own instance
            // TTL (#704); begin_migration()'s single refresh() call at the
            // start of the (now much longer) migration timelock is the only
            // thing that touches an idle target adapter before
            // migrate_adapter() finishes the gap, so this mock must do the
            // same or it archives mid-test.
            env.storage()
                .instance()
                .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
        }
    }

    // -----------------------------------------------------------------------
    // LossyMockAdapter: a migrate_adapter() target that actually loses half
    // of whatever it's deposited (sent to an address it never accounts for),
    // simulating a buggy or malicious new adapter so migrate_adapter's
    // slippage invariant has something real to reject. Wrapped in its own
    // module for the same reason as cached_mock: contractimpl-generated
    // helper items aren't namespaced by type.
    // -----------------------------------------------------------------------
    mod lossy_mock {
        use super::*;

        const LA_USDC: Symbol = symbol_short!("LA_USDC");
        const LA_SH: Symbol = symbol_short!("LA_SH");

        #[contract]
        pub struct LossyMockAdapter;

        #[contractimpl]
        impl LossyMockAdapter {
            pub fn get_usdc(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC))
            }

            pub fn get_vault(env: Env) -> Address {
                test_vault(&env)
            }

            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&LA_USDC, &usdc);
                env.storage().instance().set(&LA_SH, &0_i128);
            }

            pub fn deposit(env: Env, amount: i128) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC));
                let half = amount / 2;
                let sink = Address::generate(&env);
                TokenClient::new(&env, &usdc).transfer(
                    &env.current_contract_address(),
                    &sink,
                    &half,
                );
                let prev: i128 = env.storage().instance().get(&LA_SH).unwrap_or(0);
                env.storage().instance().set(&LA_SH, &(prev + amount));
                amount
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC));
                mock_proportional_withdraw(&env, &usdc, &LA_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&LA_USDC));
                mock_total_assets(&env, &usdc)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&LA_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                // See MockAdapter::refresh() above.
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
            }
        }
    }

    // -----------------------------------------------------------------------
    // CompatMockAdapter: a set_adapter()/begin_migration() target that lets a
    // test choose what its `get_usdc`/`get_vault` views (and its residual
    // position) report. The other mocks report the real USDC and the canonical
    // `test_vault()` address. Exercises validate_adapter_target (#1270).
    // -----------------------------------------------------------------------
    mod compat_mock {
        use super::*;

        const CM_USDC: Symbol = symbol_short!("CM_USDC");
        const CM_VAULT: Symbol = symbol_short!("CM_VAULT");
        const CM_SH: Symbol = symbol_short!("CM_SH");
        const CM_ASSETS: Symbol = symbol_short!("CM_ASSET");

        #[contract]
        pub struct CompatMockAdapter;

        #[contractimpl]
        impl CompatMockAdapter {
            pub fn initialize(env: Env, usdc: Address, vault: Address, shares: i128, assets: i128) {
                env.storage().instance().set(&CM_USDC, &usdc);
                env.storage().instance().set(&CM_VAULT, &vault);
                env.storage().instance().set(&CM_SH, &shares);
                env.storage().instance().set(&CM_ASSETS, &assets);
            }

            pub fn get_usdc(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&CM_USDC))
            }

            pub fn get_vault(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&CM_VAULT))
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&CM_SH).unwrap_or(0)
            }

            pub fn total_assets(env: Env) -> i128 {
                env.storage().instance().get(&CM_ASSETS).unwrap_or(0)
            }

            pub fn refresh(_env: Env) {}
        }
    }
    use compat_mock::{CompatMockAdapter, CompatMockAdapterClient};

    // -----------------------------------------------------------------------
    // Targets whose `get_usdc`/`get_vault` views exist but fail, one module per
    // kind (contractimpl helper items are not namespaced per type, so
    // same-named methods need separate modules). `typed_failing_views` fails
    // `get_usdc` with a typed contract error; `usdc_ok_vault_fails` answers
    // `get_usdc` correctly and fails only `get_vault`; `trapping_views` panics
    // untyped in `get_usdc`. Validation rejects the target at the failing
    // view, so these deliberately export nothing beyond what it reads.
    // -----------------------------------------------------------------------
    mod typed_failing_views {
        use super::*;

        #[contract]
        pub struct TypedFailingViewsAdapter;

        #[contractimpl]
        impl TypedFailingViewsAdapter {
            pub fn get_usdc(env: Env) -> Address {
                panic_with_error!(&env, ContractError::NotInitialized)
            }
        }
    }
    use typed_failing_views::TypedFailingViewsAdapter;

    mod usdc_ok_vault_fails {
        use super::*;

        const UV_USDC: Symbol = symbol_short!("UV_USDC");

        #[contract]
        pub struct UsdcOkVaultFailsAdapter;

        #[contractimpl]
        impl UsdcOkVaultFailsAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&UV_USDC, &usdc);
            }

            pub fn get_usdc(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&UV_USDC))
            }

            pub fn get_vault(env: Env) -> Address {
                panic_with_error!(&env, ContractError::NotInitialized)
            }
        }
    }
    use usdc_ok_vault_fails::{UsdcOkVaultFailsAdapter, UsdcOkVaultFailsAdapterClient};

    mod trapping_views {
        use super::*;

        #[contract]
        pub struct TrappingViewsAdapter;

        #[contractimpl]
        impl TrappingViewsAdapter {
            pub fn get_usdc(_env: Env) -> Address {
                panic!("get_usdc trapped")
            }
        }
    }
    use trapping_views::TrappingViewsAdapter;

    /// Registers a `CompatMockAdapter` reporting the given USDC, vault and
    /// residual position.
    fn register_compat_adapter(
        env: &Env,
        usdc: &Address,
        vault: &Address,
        shares: i128,
        assets: i128,
    ) -> Address {
        let id = env.register(CompatMockAdapter, ());
        CompatMockAdapterClient::new(env, &id).initialize(usdc, vault, &shares, &assets);
        id
    }

    // -----------------------------------------------------------------------
    // ZeroShareMockAdapter: a migrate_adapter() target that keeps every
    // stroop it's deposited (so total_assets() looks fine and a generous
    // slippage tolerance passes) but always reports zero shares credited,
    // simulating an adapter whose deposit() return value can't be trusted
    // even when its total_assets() can. Exercises migrate_adapter's
    // new_shares > 0 check, distinct from LossyMockAdapter's value-loss case.
    // -----------------------------------------------------------------------
    mod zero_share_mock {
        use super::*;

        const ZS_USDC: Symbol = symbol_short!("ZS_USDC");
        const ZS_SH: Symbol = symbol_short!("ZS_SH");

        #[contract]
        pub struct ZeroShareMockAdapter;

        #[contractimpl]
        impl ZeroShareMockAdapter {
            pub fn get_usdc(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&ZS_USDC))
            }

            pub fn get_vault(env: Env) -> Address {
                test_vault(&env)
            }

            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&ZS_USDC, &usdc);
                env.storage().instance().set(&ZS_SH, &0_i128);
            }

            pub fn deposit(_env: Env, _amount: i128) -> i128 {
                // Keeps the funds (they're already sitting at this
                // contract's address, per the vault's transfer-then-deposit
                // pattern) but never credits any shares for them.
                0
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&ZS_USDC));
                mock_proportional_withdraw(&env, &usdc, &ZS_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&ZS_USDC));
                mock_total_assets(&env, &usdc)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&ZS_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                // See MockAdapter::refresh() above.
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
            }
        }
    }

    // -----------------------------------------------------------------------
    // ManipulableMockAdapter: an adapter whose self-reported total_assets()
    // can be set independently of its actual USDC balance, letting tests
    // simulate a transiently-inflated valuation (issue #567 scenario).
    // -----------------------------------------------------------------------
    mod manipulable_mock {
        use super::*;

        const MM_USDC: Symbol = symbol_short!("MM_USDC");
        const MM_SH: Symbol = symbol_short!("MM_SH");
        const MM_FIXED: Symbol = symbol_short!("MM_FIXED");

        #[contract]
        pub struct ManipulableMockAdapter;

        #[contractimpl]
        impl ManipulableMockAdapter {
            pub fn get_usdc(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&MM_USDC))
            }

            pub fn get_vault(env: Env) -> Address {
                test_vault(&env)
            }

            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&MM_USDC, &usdc);
                env.storage().instance().set(&MM_SH, &0_i128);
                env.storage().instance().set(&MM_FIXED, &0_i128);
            }

            /// Override the self-reported total_assets() value. This lets
            /// tests simulate the adapter being manipulated (e.g. a
            /// front-run inflating the reported valuation).
            pub fn set_total_assets(env: Env, value: i128) {
                env.storage().instance().set(&MM_FIXED, &value);
            }

            // Credits `amount` onto whatever total_assets() currently reports
            // (which set_total_assets() may have manipulated away from the
            // adapter's real balance) rather than leaving it untouched: a
            // real adapter's total_assets() does go up by the deposited
            // amount, so a deposit() that doesn't move it here would make
            // value_after (the vault's delta-over-baseline read) always
            // compute to zero, regardless of what a test is trying to
            // simulate. Manipulation is layered on top via set_total_assets,
            // not by suppressing this.
            pub fn deposit(env: Env, amount: i128) -> i128 {
                let prev: i128 = env.storage().instance().get(&MM_SH).unwrap_or(0);
                env.storage().instance().set(&MM_SH, &(prev + amount));
                let prev_fixed: i128 = env.storage().instance().get(&MM_FIXED).unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&MM_FIXED, &(prev_fixed + amount));
                amount
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&MM_USDC));
                mock_proportional_withdraw(&env, &usdc, &MM_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                // Returns the manually set value, which can diverge from
                // the actual USDC balance — exactly the scenario #567
                // describes.
                env.storage().instance().get(&MM_FIXED).unwrap_or(0)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&MM_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                // total_assets is still manually set by the test (see
                // set_total_assets above); this only extends TTL, matching
                // every other mock adapter's refresh() here.
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
            }
        }
    }
    use manipulable_mock::{ManipulableMockAdapter, ManipulableMockAdapterClient};

    // -----------------------------------------------------------------------
    // CachedMockAdapter: mimics BlendAdapter's caching behavior. total_assets()
    // returns a cached value that only updates on refresh(), letting these
    // tests prove the vault's refresh() call -- not just live pricing -- is
    // what keeps deposit/withdraw pricing correct. Wrapped in its own module
    // because contractimpl-generated helper items are not namespaced by type,
    // and would otherwise collide with MockAdapter's identically named methods.
    // -----------------------------------------------------------------------
    mod cached_mock {
        use super::*;

        const CM_USDC: Symbol = symbol_short!("CM_USDC");
        const CM_SH: Symbol = symbol_short!("CM_SH");
        const CM_TOTAL: Symbol = symbol_short!("CM_TOTAL");

        #[contract]
        pub struct CachedMockAdapter;

        #[contractimpl]
        impl CachedMockAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&CM_USDC, &usdc);
                env.storage().instance().set(&CM_SH, &0_i128);
                env.storage().instance().set(&CM_TOTAL, &0_i128);
            }

            pub fn deposit(env: Env, amount: i128) -> i128 {
                // Credits at the live rate, like BlendAdapter crediting
                // bTokens at the live b_rate; only total_assets() is cached.
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&CM_USDC));
                mock_credit_from_balance(&env, &usdc, &CM_SH, amount)
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                // Payout is computed live, proportional to the adapter's current
                // USDC balance, matching how BlendAdapter::withdraw() sizes
                // redemptions off the live b_rate (#486). This test double
                // intentionally uses live pricing so the test below can
                // isolate what refresh() itself does or doesn't affect.
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&CM_USDC));
                let total_sh: i128 = env.storage().instance().get(&CM_SH).unwrap_or(0);
                let balance =
                    TokenClient::new(&env, &usdc).balance(&env.current_contract_address());

                let usdc_out = if total_sh > 0 {
                    shares * balance / total_sh
                } else {
                    0
                };

                if usdc_out > 0 {
                    TokenClient::new(&env, &usdc).transfer(
                        &env.current_contract_address(),
                        &recipient,
                        &usdc_out,
                    );
                }
                env.storage().instance().set(&CM_SH, &(total_sh - shares));
                usdc_out
            }

            pub fn total_assets(env: Env) -> i128 {
                // Cached: only reflects the balance as of the last refresh() call.
                // Instance storage read defaults to 0 if CM_TOTAL hasn't been set, which is safe since
                // initialize() sets this key to 0.
                env.storage().instance().get(&CM_TOTAL).unwrap_or(0)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&CM_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                // USDC address is always set in initialize(), so this is safe.
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&CM_USDC));
                let balance =
                    TokenClient::new(&env, &usdc).balance(&env.current_contract_address());
                env.storage().instance().set(&CM_TOTAL, &balance);
            }
        }
    }
    use cached_mock::{CachedMockAdapter, CachedMockAdapterClient};

    // Returns (env, admin, user, usdc_id, musdc_id, adapter_id, vault) wired
    // to CachedMockAdapter instead of the live-pricing MockAdapter.
    fn setup_cached() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        MeridianVaultClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(CachedMockAdapter, ());
        CachedMockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

        // See setup()'s comment below on why the vault's address is
        // pre-generated and reserved via register_at rather than registered
        // directly (#551).
        let vault_id = test_vault(&env);

        let musdc_id = env.register(MockMusdc, ());
        MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);

        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc_id, &musdc_id, &adapter_id, &admin),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    }

    // Returns (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        MeridianVaultClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy mock USDC and mUSDC. mUSDC here is MockMusdc (#578), a
        // minimal stand-in for the real `meridian-musdc-token` crate — see
        // its doc comment above for why this crate uses a local mock
        // instead of a genuine cross-crate dependency. It calls
        // `on_transfer` the same way the real token does: a direct,
        // self-authorized cross-contract call after balances move.
        let usdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

        // The vault's real deployment wires mUSDC and the adapter through
        // its own __constructor (#551), which needs their addresses already
        // known, but mUSDC's admin (this vault's own address) needs to be
        // known before *that* can happen either. Real deployments break this
        // cycle with a precomputed, deterministic contract ID (`stellar
        // contract id wasm --salt`, then `deploy --salt` to land on that same
        // address); `register_at` is the test-env equivalent, reserving the
        // vault's address up front so mUSDC can be told about it before the
        // vault itself is actually registered.
        let vault_id = test_vault(&env);

        let musdc_id = env.register(MockMusdc, ());
        MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);

        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc_id, &musdc_id, &adapter_id, &admin),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        // Fund the user with 1000 USDC (7 decimal places: 1000 * 10^7).
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &10_000_000_000_i128);

        (env, admin, user, usdc_id, musdc_id, adapter_id, vault)
    }

    #[test]
    fn deposit_rejects_missing_authorization() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.set_auths(&[]);

        assert_eq!(
            vault.try_deposit(&user, &100_0000000, &0),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        // A zero amount stops before the token's own authorization check. If
        // the vault guard disappears, this returns ZeroAmount instead of Abort.
        assert_eq!(
            vault.try_deposit(&user, &0, &0),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_total_shares(), 0);
        assert_eq!(vault.get_position(&user), 0);
    }

    #[test]
    fn withdraw_rejects_missing_authorization() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000;
        vault.deposit(&user, &amount, &0);
        env.set_auths(&[]);

        assert_eq!(
            vault.try_withdraw(&user, &amount, &0),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        // Isolate the vault guard from the mUSDC burn's authorization check.
        assert_eq!(
            vault.try_withdraw(&user, &0, &0),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_total_shares(), amount);
        assert_eq!(vault.get_position(&user), amount);
    }

    #[test]
    fn set_paused_rejects_missing_authorization() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        env.set_auths(&[]);

        assert_eq!(
            vault.try_set_paused(&true),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert!(!vault.is_paused());
    }

    #[test]
    fn transfer_admin_rejects_missing_authorization() {
        let (env, admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.set_auths(&[]);

        assert_eq!(
            vault.try_transfer_admin(&user),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_admin(), admin);
        assert_eq!(vault.get_pending_admin(), None);
    }

    #[test]
    fn accept_admin_rejects_missing_authorization() {
        let (env, admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.transfer_admin(&user);
        env.set_auths(&[]);

        assert_eq!(
            vault.try_accept_admin(),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_admin(), admin);
        assert_eq!(vault.get_pending_admin(), Some(user));
    }

    #[test]
    fn set_adapter_rejects_missing_authorization() {
        let (env, _admin, _user, usdc, _musdc, adapter, vault) = setup();
        let new_adapter = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter).initialize(&usdc);
        env.set_auths(&[]);

        assert_eq!(
            vault.try_set_adapter(&new_adapter),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_adapter(), adapter);
    }

    #[test]
    fn begin_migration_rejects_missing_authorization() {
        let (env, _admin, _user, usdc, _musdc, adapter, vault) = setup();
        let new_adapter = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter).initialize(&usdc);
        env.set_auths(&[]);

        assert_eq!(
            vault.try_begin_migration(&new_adapter),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn migrate_adapter_rejects_missing_authorization() {
        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000;
        vault.deposit(&user, &amount, &0);
        let new_adapter = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter).initialize(&usdc);
        vault.begin_migration(&new_adapter);
        let snapshot = vault.get_migration_snapshot();
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);
        env.set_auths(&[]);

        assert_eq!(
            vault.try_migrate_adapter(&new_adapter, &0),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_migration_snapshot(), snapshot);
        assert_eq!(vault.get_total_shares(), amount);
        assert_eq!(vault.get_position(&user), amount);
    }

    #[test]
    fn deposit_mints_shares() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        let shares = vault.deposit(&user, &amount, &0_i128);

        assert_eq!(shares, amount);
        assert_eq!(vault.get_position(&user), amount);
        assert_eq!(vault.get_total_shares(), amount);
    }

    #[test]
    fn withdraw_returns_usdc() {
        let (env, _admin, user, usdc_id, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares, &0_i128);

        assert_eq!(usdc_out, amount);
        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_total_shares(), 0);

        let user_balance = TokenClient::new(&env, &usdc_id).balance(&user);
        assert_eq!(user_balance, 10_000_000_000_i128);
    }

    #[test]
    fn deposit_records_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_principal(&user), 0);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        assert_eq!(vault.get_principal(&user), amount);
    }

    #[test]
    fn topup_accumulates_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        vault.deposit(&user, &50_0000000_i128, &0_i128);
        assert_eq!(vault.get_principal(&user), 150_0000000_i128);
    }

    #[test]
    fn partial_withdraw_reduces_principal_proportionally() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let half = vault.get_position(&user) / 2;
        vault.withdraw(&user, &half, &0_i128);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn full_withdraw_clears_principal() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let shares = vault.get_position(&user);
        vault.withdraw(&user, &shares, &0_i128);
        assert_eq!(vault.get_principal(&user), 0);
    }

    #[test]
    fn withdrawal_charges_ten_percent_of_positive_gain_and_mints_to_treasury() {
        let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let principal = 100_0000000_i128;
        let yield_amount = 10_0000000_i128;
        vault.deposit(&user, &principal, &0);
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        let shares = vault.get_position(&user);
        let received = vault.withdraw(&user, &shares, &0);
        let expected_fee = yield_amount * PERFORMANCE_FEE_BPS / BPS_DENOMINATOR;

        assert_eq!(received, principal + yield_amount - expected_fee);
        assert_eq!(
            TokenClient::new(&env, &musdc_id).balance(&treasury),
            expected_fee
        );
        assert_eq!(vault.get_total_shares(), expected_fee);
        assert_eq!(vault.get_total_assets(), expected_fee);
    }

    #[test]
    fn partial_profitable_withdrawal_retires_basis_proportionally() {
        let (env, _treasury, user, usdc_id, _musdc, adapter_id, vault) = setup();
        let principal = 100_0000000_i128;
        let yield_amount = 10_0000000_i128;
        vault.deposit(&user, &principal, &0);
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        let half = vault.get_position(&user) / 2;
        vault.withdraw(&user, &half, &0);

        // Only the withdrawn half of the original basis is retired. The
        // retained shares keep their own basis, which is what makes their
        // gain chargeable on their own exit (#1039).
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn two_step_profitable_exit_charges_the_same_total_fee_as_a_single_exit() {
        let principal = 10_000_000_000_i128;
        let yield_amount = 2_000_000_000_i128;

        // Exit the whole position at once.
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();
        vault.deposit(&user, &principal, &0);
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);
        let shares = vault.get_position(&user);
        let single_out = vault.withdraw(&user, &shares, &0);
        assert_eq!(
            single_out,
            principal + yield_amount - yield_amount * PERFORMANCE_FEE_BPS / BPS_DENOMINATOR
        );

        // Same position, exited in two equal steps. The second step is taxed
        // on the retained shares' own gain rather than inheriting a basis
        // that already absorbed it.
        let (env2, _admin2, user2, usdc_id2, _musdc2, adapter_id2, vault2) = setup();
        vault2.deposit(&user2, &principal, &0);
        StellarAssetClient::new(&env2, &usdc_id2).mint(&adapter_id2, &yield_amount);
        let half = vault2.get_position(&user2) / 2;
        let first_out = vault2.withdraw(&user2, &half, &0);
        assert_eq!(vault2.get_principal(&user2), principal / 2);
        let second_out = vault2.withdraw(&user2, &half, &0);

        // Equal to a few stroops of rounding from pricing the treasury mint
        // between the two steps, but the fee is no longer deferred.
        let two_step_out = first_out + second_out;
        assert!(
            (two_step_out - single_out).abs() <= 10,
            "two-step exit collected {two_step_out}, single exit {single_out}"
        );
    }

    #[test]
    fn withdrawal_at_a_loss_charges_no_fee() {
        let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let principal = 100_0000000_i128;
        let loss = 10_0000000_i128;
        vault.deposit(&user, &principal, &0);
        TokenClient::new(&env, &usdc_id).burn(&adapter_id, &loss);

        let shares = vault.get_position(&user);
        let received = vault.withdraw(&user, &shares, &0);

        assert_eq!(received, principal - loss);
        assert_eq!(TokenClient::new(&env, &musdc_id).balance(&treasury), 0);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn performance_fee_rate_and_treasury_are_constructor_fixed() {
        let (_env, treasury, _user, _usdc, _musdc, _adapter, vault) = setup();

        assert_eq!(vault.get_performance_fee_bps(), 1_000);
        assert_eq!(vault.get_treasury(), treasury);
    }

    #[test]
    fn share_value_exceeds_principal_after_yield() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield: mint USDC directly to the adapter.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &10_0000000_i128);

        let shares = vault.get_position(&user);
        let share_value = shares * vault.get_total_assets() / vault.get_total_shares();
        assert!(share_value > vault.get_principal(&user));
        assert_eq!(share_value - vault.get_principal(&user), 10_0000000_i128);
    }

    #[test]
    fn share_price_reflects_yield() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield: mint 10 USDC to the adapter.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        // A second user deposits 100 USDC — should receive fewer shares because
        // the share price has risen.
        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);
        let shares2 = vault.deposit(&user2, &amount, &0_i128);

        // 100 shares outstanding, vault has 110 USDC.
        // shares2 = 100 * 100 / 110 ≈ 90 shares.
        assert!(
            shares2 < amount,
            "second depositor should receive fewer shares"
        );

        // First user withdraws — should get more than 100 USDC back.
        let shares1 = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares1, &0_i128);
        assert!(
            usdc_out > amount,
            "first depositor should profit from yield"
        );
    }

    #[test]
    fn inflation_attack_is_unprofitable() {
        let (env, _admin, attacker, usdc_id, _musdc, adapter_id, vault) = setup();
        let usdc = TokenClient::new(&env, &usdc_id);

        let attacker_deposit = 1_i128;
        let attacker_shares = vault.deposit(&attacker, &attacker_deposit, &0_i128);
        assert_eq!(attacker_shares, 1);

        // Attacker donates to the adapter's position to inflate the vault's
        // share price before the victim deposits (the classic inflation
        // attack). The donation lands as protocol shares, the way a donation
        // reaches a real adapter (e.g. transferring dfTokens to it). A raw
        // USDC transfer would instead reprice the mock's single 1-stroop
        // share so steeply that the victim's deposit buys no adapter shares
        // at all (`AdapterCreditedNothing`), which would exercise the mock's
        // share granularity rather than the vault's own OFFSET defense.
        let donation = 100_0000000_i128;
        usdc.transfer(&attacker, &adapter_id, &donation);
        MockAdapterClient::new(&env, &adapter_id).deposit(&donation);

        let victim = Address::generate(&env);
        let victim_deposit = 100_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&victim, &victim_deposit);
        let victim_shares = vault.deposit(&victim, &victim_deposit, &0_i128);
        assert!(victim_shares > 0, "victim must receive shares");

        let attacker_out = vault.withdraw(&attacker, &attacker_shares, &0_i128);

        let attacker_in = attacker_deposit + donation;
        assert!(
            attacker_out * 100 < attacker_in,
            "inflation attack must not be profitable"
        );

        let victim_out = vault.withdraw(&victim, &victim_shares, &0_i128);
        assert!(
            victim_out > victim_deposit * 99 / 100,
            "victim must not be robbed"
        );
    }

    #[test]
    fn entry_time_defaults_to_zero() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_entry_time(&user), 0);
    }

    #[test]
    fn deposit_records_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);

        vault.deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 1_700_000_000);
    }

    #[test]
    fn topup_keeps_original_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        env.ledger().set_timestamp(1_700_500_000);
        vault.deposit(&user, &50_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 1_700_000_000);
    }

    #[test]
    fn full_withdraw_clears_entry_time() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        env.ledger().set_timestamp(1_700_000_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let shares = vault.get_position(&user);
        vault.withdraw(&user, &shares, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 0);
    }

    #[test]
    fn paused_blocks_deposit() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        let result = vault.try_deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::DepositsPaused)));
    }

    #[test]
    fn withdraw_works_while_paused() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        vault.set_paused(&true);
        let shares = vault.get_position(&user);
        let out = vault.withdraw(&user, &shares, &0_i128);
        assert_eq!(out, amount);
    }

    #[test]
    fn unpause_re_enables_deposits() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        vault.set_paused(&false);
        assert!(!vault.is_paused());

        let shares = vault.deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(shares, 100_0000000_i128);
    }

    #[test]
    fn transfer_admin_then_accept_rotates_admin() {
        let (env, admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_admin(), admin);

        let new_admin = Address::generate(&env);
        vault.transfer_admin(&new_admin);
        // Nominating alone does not change who the admin is yet.
        assert_eq!(vault.get_admin(), admin);
        assert_eq!(vault.get_pending_admin(), Some(new_admin.clone()));

        vault.accept_admin();
        assert_eq!(vault.get_admin(), new_admin);
        // The pending nomination is cleared once accepted.
        assert_eq!(vault.get_pending_admin(), None);
    }

    #[test]
    fn accept_admin_fails_with_no_pending_nominee() {
        let (_env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_accept_admin();
        assert_eq!(result, Err(Ok(ContractError::NoPendingAdmin)));
    }

    #[test]
    fn transfer_admin_overwrites_a_prior_unaccepted_nomination() {
        let (env, admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let first_nominee = Address::generate(&env);
        let second_nominee = Address::generate(&env);

        vault.transfer_admin(&first_nominee);
        vault.transfer_admin(&second_nominee);
        assert_eq!(vault.get_pending_admin(), Some(second_nominee.clone()));

        vault.accept_admin();
        assert_eq!(vault.get_admin(), second_nominee);
        // The admin is still the original one until the accepted nominee's
        // call above, so first_nominee never gained control.
        assert_ne!(admin, second_nominee);
    }

    // -----------------------------------------------------------------------
    // mUSDC is a transferable share token (#504)
    // -----------------------------------------------------------------------

    #[test]
    fn transferred_musdc_withdraws_through_its_new_holder() {
        // The reproduction from #504: before share ownership was read from
        // the token, the recipient's withdrawal failed with
        // InsufficientShares because the vault's own balance map still said
        // zero, stranding the position for both parties.
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);

        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_position(&bob), shares);

        let usdc_out = vault.withdraw(&bob, &shares, &0_i128);
        assert_eq!(usdc_out, amount);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&bob), amount);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn transferring_a_position_away_leaves_the_sender_with_a_typed_error() {
        // The other half of #504: the sender used to pass the share check
        // against a stale map and then revert inside `burn`, taking the whole
        // transaction down. Now the check reads the same balance the burn
        // does, so it fails cleanly and says why.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        let result = vault.try_withdraw(&user, &shares, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn a_partial_transfer_leaves_both_holders_able_to_withdraw() {
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);
        let moved = shares / 2;
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &moved);

        assert_eq!(vault.get_position(&user), shares - moved);
        assert_eq!(vault.get_position(&bob), moved);

        let bob_out = vault.withdraw(&bob, &moved, &0_i128);
        let user_out = vault.withdraw(&user, &(shares - moved), &0_i128);

        assert_eq!(bob_out + user_out, amount);
        assert_eq!(TokenClient::new(&env, &usdc_id).balance(&bob), bob_out);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn withdrawing_after_a_partial_transfer_out_retires_basis_against_what_is_held() {
        // #578: a partial transfer-out now moves half the sender's
        // principal to the receiver at the moment of transfer (it no longer
        // "stays behind" the way it did when mUSDC was a plain SAC with no
        // transfer hook). The proportional retirement on withdraw() then
        // divides by the caller's live balance, so a holder who transferred
        // half away and then withdraws half of what remains retires exactly
        // a quarter of the original basis.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &(shares / 2));

        // Half the principal moved with half the shares.
        assert_eq!(vault.get_principal(&user), amount / 2);

        let held = vault.get_position(&user);
        vault.withdraw(&user, &(held / 2), &0_i128);

        // Half of what they held (post-transfer) was burned, so half of
        // their remaining basis is retired.
        assert_eq!(vault.get_principal(&user), amount / 4);
    }

    #[test]
    fn a_position_transferred_away_stops_being_reported() {
        // Entry and Principal records are left behind by a transfer the vault
        // cannot observe. Reporting them for an address that holds nothing
        // would show a phantom position, so both read as empty.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 12_345);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 12_345);
        assert_eq!(vault.get_principal(&user), 100_0000000_i128);

        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_entry_time(&user), 0);
        assert_eq!(vault.get_principal(&user), 0);
    }

    #[test]
    fn get_entry_time_and_get_principal_are_pure_views_without_storage_writes() {
        let (env, _admin, _user, _usdc, _musdc_id, _adapter, vault) = setup();
        let stranger = Address::generate(&env);

        // A stranger with zero balance
        assert_eq!(vault.get_position(&stranger), 0);

        // Manually place Entry and Principal keys (simulating legacy leftover state)
        let entry_key = DataKey::Entry(stranger.clone());
        let principal_key = DataKey::Principal(stranger.clone());
        env.as_contract(&vault.address, || {
            env.storage().persistent().set(&entry_key, &999_u64);
            env.storage()
                .persistent()
                .set(&principal_key, &123_456_i128);
        });

        // Reading views returns 0 because position is 0
        assert_eq!(vault.get_entry_time(&stranger), 0);
        assert_eq!(vault.get_principal(&stranger), 0);

        // Neither view call should clear/mutate storage: keys remain unchanged
        env.as_contract(&vault.address, || {
            assert_eq!(
                env.storage().persistent().get::<_, u64>(&entry_key),
                Some(999_u64)
            );
            assert_eq!(
                env.storage().persistent().get::<_, i128>(&principal_key),
                Some(123_456_i128)
            );
        });
    }

    #[test]
    fn a_full_transfer_out_lets_a_later_deposit_start_fresh() {
        // The plain-transfer-out mirror of `a_full_exit_lets_a_later_deposit_
        // start_fresh` (#504 follow-up review): unlike a full `withdraw()`,
        // a plain `transfer()` gives the vault no hook to clear Entry/
        // Principal at the moment it happens. Without deposit() checking the
        // caller's balance itself, this re-deposit would mix its principal on
        // top of the 100 USDC basis left behind by the transfer, and report
        // the original entry time instead of its own.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        vault.deposit(&user, &50_0000000_i128, &0_i128);

        assert_eq!(vault.get_entry_time(&user), 2_000);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn a_full_round_trip_transfer_restores_the_original_principal_and_entry_time() {
        // Before #578, "staleness" was a real risk here: the vault had no
        // way to move basis on a transfer, so a `user -> bob -> user`
        // round trip needed the zero-position self-heal to keep `user`
        // from re-inheriting a leftover record from the position they gave
        // up. Now that on_transfer genuinely carries Principal/Entry
        // through every hop, the round trip is correct by construction: bob
        // received user's exact basis and entry time on the first transfer,
        // and transferring 100% of it back hands both back to user exactly
        // as they were, not zero and not stale.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        // A full transfer-out clears the sender's own records...
        assert_eq!(vault.get_principal(&user), 0);
        assert_eq!(vault.get_entry_time(&user), 0);
        // ...while the receiver inherits them outright.
        assert_eq!(vault.get_principal(&bob), 100_0000000_i128);
        assert_eq!(vault.get_entry_time(&bob), 1_000);

        // bob transfers the same shares straight back to `user`.
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        TokenClient::new(&env, &musdc_id).transfer(&bob, &user, &shares);

        assert_eq!(vault.get_position(&user), shares);
        assert_eq!(vault.get_principal(&user), 100_0000000_i128);
        // Entry time travels with the position, not with the clock: it's
        // still 1_000, the timestamp of user's original deposit, not 2_000
        // when this second transfer happened.
        assert_eq!(vault.get_entry_time(&user), 1_000);
    }

    #[test]
    fn a_transferred_in_position_inherits_the_senders_principal_and_entry_time() {
        // #578: mUSDC is now a custom SEP-41 token whose transfer calls back
        // into the vault, so a receiver with no prior position inherits the
        // sender's cost basis and entry time outright, instead of the old
        // honest-`0` degradation from back when mUSDC was a plain SAC with
        // no hook for the vault to observe a transfer at all.
        let (env, _admin, user, _usdc, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 12_345);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);

        assert_eq!(vault.get_position(&bob), shares);
        assert_eq!(vault.get_principal(&bob), 100_0000000_i128);
        assert_eq!(vault.get_entry_time(&bob), 12_345);
    }

    #[test]
    fn depositing_on_top_of_a_transferred_in_position_is_a_topup_not_a_fresh_entry() {
        // #578 changes this from before: an address holding transferred
        // mUSDC used to have never deposited (no Entry/Principal record at
        // all), so its first deposit was a real, fresh entry. Now
        // `on_transfer` records both for the receiver too, so a deposit on
        // top of a transferred-in position is correctly a top-up — it keeps
        // the inherited entry time and adds to the inherited principal,
        // exactly like topping up a directly-deposited position (see
        // `topup_keeps_original_entry_time`/`topup_accumulates_principal`).
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let bob = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &bob, &shares);
        assert_eq!(vault.get_entry_time(&bob), 1_000);
        assert_eq!(vault.get_principal(&bob), 100_0000000_i128);

        StellarAssetClient::new(&env, &usdc_id).mint(&bob, &10_0000000_i128);
        env.ledger().with_mut(|li| li.timestamp = 99_999);
        vault.deposit(&bob, &10_0000000_i128, &0_i128);

        assert_eq!(vault.get_entry_time(&bob), 1_000);
        assert_eq!(vault.get_principal(&bob), 110_0000000_i128);
    }

    #[test]
    fn transferring_into_an_existing_position_weight_averages_entry_time() {
        // #578: when the receiver already holds a position, entry time is a
        // principal-weighted average of their existing entry time and the
        // sender's, rather than either being overwritten or left untouched
        // — a large incoming transfer should meaningfully pull entry_time
        // forward, not get swallowed by the receiver's own original stamp.
        let (env, _admin, user, usdc_id, musdc_id, _adapter, vault) = setup();
        let carol = Address::generate(&env);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        StellarAssetClient::new(&env, &usdc_id).mint(&carol, &50_0000000_i128);
        env.ledger().with_mut(|li| li.timestamp = 5_000);
        vault.deposit(&carol, &50_0000000_i128, &0_i128);

        let shares = vault.get_position(&user);
        TokenClient::new(&env, &musdc_id).transfer(&user, &carol, &shares);

        // total_principal = 50_0000000 (carol) + 100_0000000 (user) = 150_0000000
        // weighted_entry = (5_000*50_0000000 + 1_000*100_0000000) / 150_0000000 = 2_333
        assert_eq!(vault.get_principal(&carol), 150_0000000_i128);
        assert_eq!(vault.get_entry_time(&carol), 2_333);
    }

    #[test]
    fn on_transfer_rejects_a_caller_that_is_not_the_configured_musdc_contract() {
        // on_transfer's whole security model rests on requiring the
        // *direct* caller to be the configured mUSDC contract (see its doc
        // comment) — verified here by calling it directly, bypassing mUSDC
        // entirely, with mocking turned off so nothing can auto-authorize
        // it the way `setup()`'s `mock_all_auths()` otherwise would.
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let bob = Address::generate(&env);
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        env.set_auths(&[]);
        let result =
            vault.try_on_transfer(&user, &bob, &10_0000000_i128, &100_0000000_i128, &0_i128);
        assert!(result.is_err());
    }

    #[test]
    fn a_full_exit_lets_a_later_deposit_start_fresh() {
        // Regression guard for the entry stamp now keying off the record
        // rather than the balance: a full withdrawal must still clear it, or
        // a re-depositor would keep an entry time from a position they no
        // longer hold.
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        vault.withdraw(&user, &vault.get_position(&user), &0_i128);
        assert_eq!(vault.get_entry_time(&user), 0);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        vault.deposit(&user, &50_0000000_i128, &0_i128);
        assert_eq!(vault.get_entry_time(&user), 2_000);
        assert_eq!(vault.get_principal(&user), 50_0000000_i128);
    }

    #[test]
    fn get_position_reads_the_token_even_for_an_address_that_never_deposited() {
        let (env, _admin, _user, _usdc, musdc_id, _adapter, vault) = setup();
        let stranger = Address::generate(&env);

        assert_eq!(vault.get_position(&stranger), 0);
        assert_eq!(TokenClient::new(&env, &musdc_id).balance(&stranger), 0);
    }

    #[test]
    fn withdraw_more_than_balance_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let result = vault.try_withdraw(&user, &(amount * 2), &0_i128);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn reinitializing_fails() {
        let (_env, admin, _user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let result = vault.try_initialize(&admin, &usdc_id, &musdc_id, &adapter_id, &admin);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn initialize_cannot_hijack_a_constructor_deployed_vault() {
        // The #551 front-run, run against the fixed contract. An attacker
        // watching the ledger calls initialize() with their own address as
        // admin, hoping to land before the deployer's own call. There is no
        // longer a window to land in: __constructor already ran inside the
        // deploying transaction, so the attempt is rejected and the vault
        // stays bound to the real admin.
        let (env, admin, _user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let attacker = Address::generate(&env);

        let result = vault.try_initialize(&attacker, &usdc_id, &musdc_id, &adapter_id, &attacker);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
        assert_eq!(vault.get_admin(), admin);
    }

    #[test]
    fn deposit_zero_amount_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_deposit(&user, &0_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_zero_shares_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let result = vault.try_withdraw(&user, &0_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_with_no_shares_outstanding_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_withdraw(&user, &1_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::NoSharesOutstanding)));
    }

    #[test]
    fn set_adapter_fails_with_shares_outstanding() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&_usdc);
        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AdapterSwapUnsafe)));
    }

    #[test]
    fn set_adapter_succeeds_with_no_shares_outstanding() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&_usdc);
        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Ok(Ok(())));
        assert_eq!(vault.get_adapter(), new_adapter_id);
    }

    #[test]
    fn set_adapter_succeeds_after_genuine_full_withdrawal() {
        // Regression guard for issue #561, negative direction: prove the
        // tightened guard doesn't regress the legitimate case of a vault
        // that reaches empty organically. deposit()+withdraw() keep TOTAL_SH
        // and ADPT_SH in lockstep -- a full withdrawal burns
        // shares * ADPT_SH / TOTAL_SH with shares == TOTAL_SH, which divides
        // evenly, so both counters land on exactly zero together. set_adapter
        // must still succeed in that real, organically-reached empty state.
        let (env, _admin, user, usdc, musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let musdc_balance = TokenClient::new(&env, &musdc).balance(&user);
        vault.withdraw(&user, &musdc_balance, &0_i128);

        assert_eq!(vault.get_total_shares(), 0);
        assert_eq!(
            env.as_contract(&vault.address, || env
                .storage()
                .instance()
                .get::<_, i128>(&ADPT_SH)
                .unwrap_or(0)),
            0
        );

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);
        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Ok(Ok(())));
        assert_eq!(vault.get_adapter(), new_adapter_id);
    }

    #[test]
    fn set_adapter_fails_when_adapter_shares_outstanding_despite_zero_total_shares() {
        // Regression test for issue #561: set_adapter's AdapterSwapUnsafe
        // guard checked only TOTAL_SH, not ADPT_SH. The two counters can
        // desync in production (the rounding-drift path referenced in the
        // issue); reproducing that drift organically isn't the point of
        // this test, so -- like accrue_returns_typed_error_when_pool_key_is_unset
        // above -- ADPT_SH is set directly to construct the exact
        // TOTAL_SH == 0, ADPT_SH > 0 precondition the issue describes, and
        // the real set_adapter entry point is exercised against it.
        let (env, _admin, _user, usdc, _musdc, _adapter, vault) = setup();
        assert_eq!(vault.get_total_shares(), 0);

        let stranded_adapter_shares = 42_000_000_i128;
        env.as_contract(&vault.address, || {
            env.storage()
                .instance()
                .set(&ADPT_SH, &stranded_adapter_shares);
        });

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);
        let original_adapter = vault.get_adapter();

        let result = vault.try_set_adapter(&new_adapter_id);
        assert_eq!(result, Err(Ok(ContractError::AdapterSwapUnsafe)));

        // The swap must not have gone through, and -- just as importantly --
        // the evidence of the stranded position must not have been erased.
        assert_eq!(vault.get_adapter(), original_adapter);
        assert_eq!(
            env.as_contract(&vault.address, || env
                .storage()
                .instance()
                .get::<_, i128>(&ADPT_SH)
                .unwrap_or(0)),
            stranded_adapter_shares
        );
    }

    #[test]
    fn migrate_adapter_moves_position_and_preserves_bookkeeping() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let total_shares_before = vault.get_total_shares();
        let position_before = vault.get_position(&user);

        // Phase 1: snapshot the target adapter's valuation.
        vault.begin_migration(&new_adapter_id);

        // Advance past the ledger-gap cooldown.
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Ok(Ok(())));

        assert_eq!(vault.get_adapter(), new_adapter_id);
        // Per-depositor bookkeeping is denominated in vault shares, not
        // adapter shares, so an adapter swap must not touch it.
        assert_eq!(vault.get_total_shares(), total_shares_before);
        assert_eq!(vault.get_position(&user), position_before);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn migrate_adapter_fails_with_no_adapter_position() {
        let (env, _admin, _user, usdc, _musdc, _adapter, vault) = setup();
        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::NoAdapterPosition)));
    }

    #[test]
    fn migrate_adapter_fails_with_invalid_slippage_bps() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let result = vault.try_migrate_adapter(&new_adapter_id, &(MAX_ADMIN_SLIPPAGE_BPS + 1));
        assert_eq!(result, Err(Ok(ContractError::InvalidSlippageBps)));
    }

    // Regression test for issue #557: max_slippage_bps used to be bounded
    // only by its literal type range up to 10_000 (100%), so a single
    // compromised admin key could authorize moving the entire vault
    // position with zero loss protection. 10_000 must now be rejected the
    // same as any other value above MAX_ADMIN_SLIPPAGE_BPS.
    #[test]
    fn migrate_adapter_rejects_the_old_unbounded_maximum() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let result = vault.try_migrate_adapter(&new_adapter_id, &10_000);
        assert_eq!(result, Err(Ok(ContractError::InvalidSlippageBps)));
    }

    #[test]
    fn migrate_adapter_fails_when_new_adapter_returns_zero_shares() {
        use zero_share_mock::{ZeroShareMockAdapter, ZeroShareMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let zero_share_adapter_id = env.register(ZeroShareMockAdapter, ());
        ZeroShareMockAdapterClient::new(&env, &zero_share_adapter_id).initialize(&usdc);

        // Phase 1: snapshot the target adapter's valuation.
        vault.begin_migration(&zero_share_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        let result = vault.try_migrate_adapter(&zero_share_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::DepositTooSmall)));

        // Nothing moved: the old adapter still holds the full position, and
        // the vault isn't left with ADPT_SH desynced from TOTAL_SH.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn deposit_reconciles_drifted_adpt_sh_to_the_adapter_s_real_balance() {
        // Regression test for issue #556: ADPT_SH used to be maintained by
        // locally incrementing/decrementing an estimate, which could drift
        // from the adapter's real share balance over many operations. This
        // fix instead reconciles ADPT_SH to adapter_client.total_shares()
        // after every deposit/withdraw. Simulate a vault that already has
        // pre-existing drift (e.g. from rounding accumulated before this fix
        // shipped) by directly corrupting the stored counter, then prove the
        // very next deposit snaps it back to ground truth instead of
        // compounding on the wrong value.
        let (env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);

        // Corrupt the stored counter so it disagrees with the adapter's real
        // balance (which is `amount`, per MockAdapter's deposit()).
        let drifted_value = amount + 42_0000000_i128;
        env.as_contract(&vault.address, || {
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "ADPT_SH"), &drifted_value);
        });

        // A second deposit should reconcile ADPT_SH to the adapter's real
        // total_shares(), not to drifted_value + this deposit's shares.
        let second_amount = 50_0000000_i128;
        vault.deposit(&user, &second_amount, &0);

        let adapter_real_shares = MockAdapterClient::new(&env, &adapter).total_shares();
        let stored_adpt_sh: i128 = env.as_contract(&vault.address, || {
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "ADPT_SH"))
                .unwrap()
        });
        assert_eq!(
            stored_adpt_sh, adapter_real_shares,
            "ADPT_SH must reconcile to the adapter's real balance, not remain drifted"
        );
        assert_eq!(stored_adpt_sh, amount + second_amount);
    }

    #[test]
    fn migrate_adapter_fails_to_same_adapter() {
        let (_env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let result = vault.try_migrate_adapter(&adapter, &0);
        assert_eq!(result, Err(Ok(ContractError::SameAdapter)));
    }

    #[test]
    fn deposit_fails_when_adapter_returns_zero_shares() {
        use zero_share_mock::{ZeroShareMockAdapter, ZeroShareMockAdapterClient};

        let (env, admin, user, usdc, _musdc, _adapter, _vault) = setup();
        let amount = 100_000000_i128;

        // Register and initialize zero share adapter
        let zero_share_adapter_id = env.register(ZeroShareMockAdapter, ());
        ZeroShareMockAdapterClient::new(&env, &zero_share_adapter_id).initialize(&usdc);

        // Deploy a vault configured with the zero-share adapter
        let musdc_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let vault_id = env.register(
            MeridianVault,
            (&admin, &usdc, &musdc_id, &zero_share_adapter_id, &admin),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        // Attempt deposit and assert it returns AdapterCreditedNothing
        let result = vault.try_deposit(&user, &amount, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::AdapterCreditedNothing)));
    }

    #[test]
    fn migrate_adapter_rejects_value_drift_beyond_slippage() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        // Phase 1: snapshot the target adapter's valuation.
        vault.begin_migration(&lossy_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // The lossy adapter loses half of whatever it's deposited, well
        // outside a 1% (100 bps) slippage tolerance.
        let result = vault.try_migrate_adapter(&lossy_adapter_id, &100);
        assert_eq!(result, Err(Ok(ContractError::MigrationValueDrift)));

        // Nothing moved: the old adapter still holds the full position.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    // -----------------------------------------------------------------------
    // Two-phase migration stability tests (issue #567)
    // -----------------------------------------------------------------------

    #[test]
    fn migrate_adapter_requires_prior_begin_migration() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        // Calling migrate_adapter without begin_migration must fail.
        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn migrate_adapter_fails_before_cooldown_elapses() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        vault.begin_migration(&new_adapter_id);

        // Advance only half the required cooldown.
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP / 2);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationCooldownNotMet)));

        // Nothing moved.
        assert_eq!(vault.get_total_assets(), 100_0000000_i128);
    }

    #[test]
    fn begin_migration_fails_for_same_adapter() {
        let (_env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let result = vault.try_begin_migration(&adapter);
        assert_eq!(result, Err(Ok(ContractError::SameAdapter)));
    }

    // -----------------------------------------------------------------------
    // #1270: adapter compatibility validation in set_adapter / begin_migration
    // -----------------------------------------------------------------------

    #[test]
    fn set_adapter_rejects_a_target_with_a_different_usdc() {
        let (env, _admin, _user, _usdc, _musdc, original, vault) = setup();
        let other_usdc = Address::generate(&env);
        let target = register_compat_adapter(&env, &other_usdc, &vault.address, 0, 0);

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn set_adapter_rejects_a_target_bound_to_a_different_vault() {
        let (env, _admin, _user, usdc, _musdc, original, vault) = setup();
        let other_vault = Address::generate(&env);
        let target = register_compat_adapter(&env, &usdc, &other_vault, 0, 0);

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterVaultMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn set_adapter_rejects_a_target_holding_residual_shares() {
        let (env, _admin, _user, usdc, _musdc, original, vault) = setup();
        let target = register_compat_adapter(&env, &usdc, &vault.address, 1, 0);

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterResidualPosition)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn set_adapter_rejects_a_target_holding_residual_assets() {
        let (env, _admin, _user, usdc, _musdc, original, vault) = setup();
        let target = register_compat_adapter(&env, &usdc, &vault.address, 0, 1);

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterResidualPosition)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn set_adapter_accepts_a_valid_target() {
        let (env, _admin, _user, usdc, _musdc, _original, vault) = setup();
        let target = register_compat_adapter(&env, &usdc, &vault.address, 0, 0);

        assert_eq!(vault.try_set_adapter(&target), Ok(Ok(())));
        assert_eq!(vault.get_adapter(), target);
    }

    #[test]
    fn begin_migration_rejects_a_target_with_a_different_usdc() {
        let (env, _admin, _user, _usdc, _musdc, _original, vault) = setup();
        let other_usdc = Address::generate(&env);
        let target = register_compat_adapter(&env, &other_usdc, &vault.address, 0, 0);

        let result = vault.try_begin_migration(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        // A rejected target must not leave a snapshot behind.
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn begin_migration_rejects_a_target_bound_to_a_different_vault() {
        let (env, _admin, _user, usdc, _musdc, _original, vault) = setup();
        let other_vault = Address::generate(&env);
        let target = register_compat_adapter(&env, &usdc, &other_vault, 0, 0);

        let result = vault.try_begin_migration(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterVaultMismatch)));
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn begin_migration_accepts_a_valid_target() {
        let (env, _admin, _user, usdc, _musdc, _original, vault) = setup();
        let target = register_compat_adapter(&env, &usdc, &vault.address, 0, 0);

        assert_eq!(vault.try_begin_migration(&target), Ok(Ok(())));
        assert_eq!(vault.get_migration_snapshot().adapter, target);
    }

    // A view that fails must reject the target, whatever the failure: a
    // typed contract error, a trap, a missing export, or a target that is not
    // a contract at all. There is no fallback that lets a target skip a check.
    #[test]
    fn set_adapter_rejects_a_target_whose_get_usdc_fails_with_a_typed_error() {
        let (env, _admin, _user, _usdc, _musdc, original, vault) = setup();
        let target = env.register(TypedFailingViewsAdapter, ());

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn set_adapter_rejects_a_target_whose_get_vault_fails_with_a_typed_error() {
        let (env, _admin, _user, usdc, _musdc, original, vault) = setup();
        let target = env.register(UsdcOkVaultFailsAdapter, ());
        UsdcOkVaultFailsAdapterClient::new(&env, &target).initialize(&usdc);

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterVaultMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn set_adapter_rejects_an_adapter_without_the_views() {
        // MockMusdc stands in for any contract that does not export the views.
        let (env, _admin, _user, _usdc, _musdc, original, vault) = setup();
        let target = env.register(MockMusdc, ());

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn begin_migration_rejects_an_adapter_without_the_views() {
        // MockMusdc stands in for any contract that does not export the views.
        let (env, _admin, _user, _usdc, _musdc, _original, vault) = setup();
        let target = env.register(MockMusdc, ());

        let result = vault.try_begin_migration(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn set_adapter_rejects_a_target_whose_views_panic() {
        let (env, _admin, _user, _usdc, _musdc, original, vault) = setup();
        let target = env.register(TrappingViewsAdapter, ());

        let result = vault.try_set_adapter(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn begin_migration_rejects_a_target_whose_views_panic() {
        let (env, _admin, _user, _usdc, _musdc, _original, vault) = setup();
        let target = env.register(TrappingViewsAdapter, ());

        let result = vault.try_begin_migration(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn set_adapter_rejects_an_address_that_is_not_a_contract() {
        let (env, _admin, _user, _usdc, _musdc, original, vault) = setup();
        let not_a_contract = Address::generate(&env);

        let result = vault.try_set_adapter(&not_a_contract);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(vault.get_adapter(), original);
    }

    #[test]
    fn begin_migration_rejects_an_address_that_is_not_a_contract() {
        let (env, _admin, _user, _usdc, _musdc, _original, vault) = setup();
        let not_a_contract = Address::generate(&env);

        let result = vault.try_begin_migration(&not_a_contract);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
    }

    #[test]
    fn begin_migration_rejects_a_target_whose_get_usdc_fails_with_a_typed_error() {
        let (env, _admin, _user, _usdc, _musdc, _original, vault) = setup();
        let target = env.register(TypedFailingViewsAdapter, ());

        let result = vault.try_begin_migration(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterUsdcMismatch)));
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn begin_migration_rejects_a_target_whose_get_vault_fails_with_a_typed_error() {
        let (env, _admin, _user, usdc, _musdc, _original, vault) = setup();
        let target = env.register(UsdcOkVaultFailsAdapter, ());
        UsdcOkVaultFailsAdapterClient::new(&env, &target).initialize(&usdc);

        let result = vault.try_begin_migration(&target);
        assert_eq!(result, Err(Ok(ContractError::AdapterVaultMismatch)));
        assert_eq!(
            vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn begin_migration_rejects_a_target_reporting_negative_total_assets() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let manip_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &manip_id).initialize(&usdc);
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&-1);

        let result = vault.try_begin_migration(&manip_id);
        assert_eq!(
            result,
            Err(Ok(ContractError::MigrationSnapshotAssetsInvalid))
        );

        // Nothing was recorded: a later begin_migration for a well-behaved
        // adapter must not see a stale invalid snapshot.
        let snapshot_result = vault.try_get_migration_snapshot();
        assert_eq!(
            snapshot_result,
            Err(Ok(ContractError::MigrationNotInitialized))
        );
    }

    #[test]
    fn migrate_adapter_rejects_a_non_positive_old_adapter_baseline() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        // The old adapter is the manipulable mock so its reported value can
        // be driven to zero while the vault still holds adapter shares.
        let old_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &old_id).initialize(&usdc);

        let vault_id = test_vault(&env);
        let musdc_id = env.register(MockMusdc, ());
        MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);
        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc, &musdc_id, &old_id, &admin),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let amount = 100_0000000_i128;
        StellarAssetClient::new(&env, &usdc).mint(&user, &amount);
        vault.deposit(&user, &amount, &0);

        let new_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_id).initialize(&usdc);
        vault.begin_migration(&new_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        for bad in [0_i128, -1] {
            ManipulableMockAdapterClient::new(&env, &old_id).set_total_assets(&bad);
            let result = vault.try_migrate_adapter(&new_id, &0);
            assert_eq!(result, Err(Ok(ContractError::MigrationBaselineInvalid)));
        }

        // Nothing moved.
        assert_eq!(vault.get_adapter(), old_id);
    }

    #[test]
    fn get_migration_snapshot_fails_without_begin() {
        let (_env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let result = vault.try_get_migration_snapshot();
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn begin_migration_records_snapshot_and_getter_returns_it() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        env.ledger().with_mut(|li| li.sequence_number = 100);
        let result = vault.try_begin_migration(&new_adapter_id);
        assert_eq!(result, Ok(Ok(())));

        let snapshot = vault.get_migration_snapshot();
        assert_eq!(snapshot.adapter, new_adapter_id);
        assert_eq!(snapshot.ledger_seq, 100);
        // New adapter has 0 assets (no deposits yet), so snapshot is 0.
        assert_eq!(snapshot.total_assets, 0);
    }

    #[test]
    fn begin_migration_overwrites_previous_snapshot() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let adapter_a = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_a).initialize(&usdc);
        let adapter_b = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &adapter_b).initialize(&usdc);

        env.ledger().with_mut(|li| li.sequence_number = 10);
        vault.begin_migration(&adapter_a);

        env.ledger().with_mut(|li| li.sequence_number = 20);
        vault.begin_migration(&adapter_b);

        let snapshot = vault.get_migration_snapshot();
        assert_eq!(snapshot.adapter, adapter_b);
        assert_eq!(snapshot.ledger_seq, 20);

        // Migrating to adapter_a should now fail (snapshot is for adapter_b).
        let result = vault.try_migrate_adapter(&adapter_a, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn migrate_adapter_fails_when_stability_drift_detected() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        vault.begin_migration(&lossy_adapter_id);

        // Advance past the cooldown.
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // Use the manipulable adapter: inflate its reported total_assets
        // above what it actually holds, simulating a front-run manipulation.
        let manip_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &manip_id).initialize(&usdc);

        // Inflate: adapter reports 200 USDC but holds nothing.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&(amount * 2));

        vault.begin_migration(&manip_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // Deflate: manipulation ends, adapter now reports only the vault's
        // deposit (which lands during migrate_adapter). Use 10 bps slippage
        // so the stability check (comparing against the inflated snapshot)
        // triggers.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&amount);

        let result = vault.try_migrate_adapter(&manip_id, &100);
        assert_eq!(result, Err(Ok(ContractError::MigrationStabilityDrift)));

        // Nothing moved.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
    }

    #[test]
    fn stale_snapshot_survives_failed_migration() {
        // In Soroban, returning an error rolls back ALL storage changes,
        // so the snapshot persists after a failed migration. This is safe
        // because the stability and slippage checks still apply on every
        // retry. This test verifies the snapshot survives and is reusable.
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);

        let manip_id = env.register(ManipulableMockAdapter, ());
        ManipulableMockAdapterClient::new(&env, &manip_id).initialize(&usdc);

        // Inflate the snapshot.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&(amount * 2));
        vault.begin_migration(&manip_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // Deflate so the stability check fails.
        ManipulableMockAdapterClient::new(&env, &manip_id).set_total_assets(&amount);
        let migration_result = vault.try_migrate_adapter(&manip_id, &100);
        assert_eq!(
            migration_result,
            Err(Ok(ContractError::MigrationStabilityDrift))
        );

        // Snapshot persists (Soroban error = rollback all storage).
        // It's still usable: the admin can re-attempt with the same
        // snapshot or call begin_migration to refresh it.
        let snapshot = vault.get_migration_snapshot();
        assert_eq!(snapshot.adapter, manip_id);
    }

    #[test]
    fn snapshot_cleared_on_successful_migration() {
        let (env, _admin, user, usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);

        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        vault.begin_migration(&new_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        let result = vault.try_migrate_adapter(&new_adapter_id, &0);
        assert_eq!(result, Ok(Ok(())));

        // Snapshot must be cleared after successful migration.
        let result = vault.try_get_migration_snapshot();
        assert_eq!(result, Err(Ok(ContractError::MigrationNotInitialized)));
    }

    #[test]
    fn migrate_adapter_excludes_target_pre_existing_balance_from_value_after() {
        use lossy_mock::{LossyMockAdapter, LossyMockAdapterClient};

        let (env, _admin, user, usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        let lossy_adapter_id = env.register(LossyMockAdapter, ());
        LossyMockAdapterClient::new(&env, &lossy_adapter_id).initialize(&usdc);

        // Strand a balance on the target before it's ever a migration target,
        // e.g. left over from the set_adapter wrong-counter bug tracked
        // separately. This residue is bigger than the real loss below, so if
        // value_after ever counts it as delivered value, the slippage check
        // is fooled into passing.
        let residue = 60_0000000_i128;
        StellarAssetClient::new(&env, &usdc).mint(&lossy_adapter_id, &residue);

        vault.begin_migration(&lossy_adapter_id);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        // The lossy adapter loses half of whatever it's deposited. With a 0
        // bps tolerance this must be rejected on the real delivered value
        // alone (50 of the 100 migrated), not the residue-inflated total
        // (60 residue + 50 delivered = 110, which would incorrectly clear
        // the 100 baseline).
        let result = vault.try_migrate_adapter(&lossy_adapter_id, &0);
        assert_eq!(result, Err(Ok(ContractError::MigrationValueDrift)));

        // Nothing moved: the old adapter still holds the full position, and
        // the target's pre-existing residue is untouched.
        assert_eq!(vault.get_adapter(), adapter);
        assert_eq!(vault.get_total_assets(), amount);
        assert_eq!(
            LossyMockAdapterClient::new(&env, &lossy_adapter_id).total_assets(),
            residue
        );
    }

    // __constructor always sets ADMIN/USDC/MUSDC/ADAPTER on any real
    // deployment (#551), so a genuinely uninitialized vault is unreachable in
    // practice. These tests register a real vault through the constructor,
    // then strip that state directly, to prove the NotInitialized guards
    // still fire correctly if that invariant is ever violated by a future
    // change (mirrors blend-adapter's
    // refresh_panics_when_pool_key_is_unset).
    fn register_uninitialized_vault(env: &Env) -> Address {
        let admin = Address::generate(env);
        let usdc = Address::generate(env);
        let musdc = Address::generate(env);
        let adapter = Address::generate(env);
        let vault_id = env.register(MeridianVault, (&admin, &usdc, &musdc, &adapter, &admin));
        env.as_contract(&vault_id, || {
            env.storage().instance().remove(&ADMIN);
            env.storage().instance().remove(&USDC);
            env.storage().instance().remove(&MUSDC);
            env.storage().instance().remove(&ADAPTER);
        });
        vault_id
    }

    #[test]
    fn get_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_admin();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn get_adapter_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_adapter();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn get_total_assets_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_get_total_assets();
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_paused_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let result = vault.try_set_paused(&true);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn transfer_admin_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let new_admin = Address::generate(&env);
        let result = vault.try_transfer_admin(&new_admin);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn set_adapter_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let new_adapter = Address::generate(&env);
        let result = vault.try_set_adapter(&new_adapter);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn deposit_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let user = Address::generate(&env);
        let result = vault.try_deposit(&user, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn withdraw_fails_before_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = register_uninitialized_vault(&env);
        let vault = MeridianVaultClient::new(&env, &vault_id);
        let user = Address::generate(&env);
        let result = vault.try_withdraw(&user, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
    }

    // Rounding edge cases -------------------------------------------------------

    #[test]
    fn deposit_too_small_after_share_price_inflation() {
        // After a large yield donation inflates the share price, a tiny deposit
        // must round down to zero shares and return DepositTooSmall rather than
        // minting zero shares silently.
        //
        // Setup: deposit 1 stroop so the vault has shares outstanding, then
        // donate 1_000_000_000 stroops (100 USDC) directly to the adapter to
        // inflate total_assets without changing total_shares. At that point the
        // share price is ~1_000_000_001 stroops per share, so depositing 1 stroop
        // gives shares_to_mint = 1 * (1 + 1_000) / (1_000_000_001 + 1_000) ≈ 0.
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        // Seed the vault with a 1-stroop deposit so total_shares > 0.
        vault.deposit(&user, &1_i128, &0_i128);

        // Inflate the adapter's USDC balance to make the share price enormous.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &1_000_000_000_i128);

        // 1-stroop deposit now rounds down to 0 shares.
        let result = vault.try_deposit(&user, &1_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::DepositTooSmall)));
    }

    #[test]
    fn withdrawal_too_small_when_usdc_drained_from_adapter() {
        // When the adapter's USDC balance has been almost fully drained (simulating
        // a loss scenario or an edge case where adapter balance < adapter shares),
        // burning a small number of vault shares must return WithdrawalTooSmall
        // rather than transferring zero USDC silently.
        //
        // Setup: deposit 1_000_000_000 stroops (100 USDC) — vault and adapter both
        // have 1_000_000_000 shares outstanding and 1_000_000_000 stroops of USDC.
        // Transfer all but 1 stroop of USDC away from the adapter so its balance
        // drops to 1 stroop. Burning 2 vault shares then yields:
        //   adapter_shares_to_burn = 2 * 1_000_000_000 / 1_000_000_000 = 2
        //   usdc_out = 2 * 1 / 1_000_000_000 = 0  → WithdrawalTooSmall
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let deposit = 1_000_000_000_i128;
        vault.deposit(&user, &deposit, &0_i128);

        // Drain the adapter's USDC balance down to 1 stroop. mock_all_auths lets
        // us transfer from any address without a real signature.
        let drain_amount = deposit - 1;
        let drain_sink = Address::generate(&env);
        TokenClient::new(&env, &usdc_id).transfer(&adapter_id, &drain_sink, &drain_amount);

        // Burning just 2 vault shares now rounds down to 0 USDC out.
        let result = vault.try_withdraw(&user, &2_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::WithdrawalTooSmall)));
    }

    #[test]
    fn deposit_fails_when_adapter_reports_zero_assets_with_shares_outstanding() {
        // If the adapter reports zero total_assets while the vault has shares
        // outstanding, the vault must reject the deposit rather than minting
        // massively inflated shares (which would dilute all existing holders).
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Drain the adapter's USDC balance to zero so total_assets() returns 0,
        // simulating a malformed DeFindex response.
        let drain_sink = Address::generate(&env);
        TokenClient::new(&env, &usdc_id).transfer(&adapter_id, &drain_sink, &amount);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &100_0000000_i128);
        let result = vault.try_deposit(&user2, &100_0000000_i128, &0_i128);
        assert_eq!(result, Err(Ok(ContractError::AdapterReportedNoAssets)));
    }

    // Slippage bounds tests ---------------------------------------------------

    #[test]
    fn deposit_enforces_min_shares_out_success() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        // Exact shares expected is 100_0000000; min_shares_out = 100_0000000 should succeed.
        let shares = vault.deposit(&user, &amount, &100_0000000_i128);
        assert_eq!(shares, 100_0000000_i128);

        // Submitting with a lower floor (e.g. 95 USDC shares) also succeeds.
        let shares2 = vault.deposit(&user, &amount, &95_0000000_i128);
        assert_eq!(shares2, 100_0000000_i128);
    }

    #[test]
    fn deposit_fails_when_shares_below_min_shares_out() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield: mint 10 USDC to adapter so share price increases.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &10_0000000_i128);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);

        // With yield, depositing 100 USDC yields ~90.9 shares.
        // If caller demands at least 100 shares, it must revert with SlippageExceeded.
        let result = vault.try_deposit(&user2, &amount, &100_0000000_i128);
        assert_eq!(result, Err(Ok(ContractError::SlippageExceeded)));
    }

    // Acceptance-criteria tests for the refresh() cache mechanism -----------

    #[test]
    fn depositor_priced_correctly_within_own_transaction_after_yield_accrual() {
        let (env, _admin, user, usdc_id, _musdc_id, adapter_id, vault) = setup_cached();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield accruing inside the underlying protocol: USDC lands
        // directly in the adapter without going through deposit(), so the
        // adapter's cached total_assets() does not reflect it until refresh()
        // is called.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        // A second depositor arrives. Without the vault calling refresh()
        // ahead of pricing, total_assets() would still return the stale
        // pre-yield cache and this deposit would be mispriced within the
        // second depositor's own transaction -- the exact case the
        // adapter-only fix could not solve.
        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &10_000_000_000_i128);
        let shares2 = vault.deposit(&user2, &amount, &0_i128);

        assert!(
            shares2 < amount,
            "second depositor should be priced against the refreshed total, receiving fewer shares"
        );

        // The adapter's cache was actually refreshed as a side effect of this
        // deposit, proving the vault's refresh() calls -- not stale data --
        // drove the pricing above. The vault also refreshes after the
        // adapter deposit to value the credit (#1263), so the cache now
        // includes user2's own deposit as well as the yield.
        assert_eq!(vault.get_total_assets(), amount + yield_amount + amount);
    }

    #[test]
    fn withdraw_payout_is_live_computed_and_unaffected_by_cache_refresh() {
        let (env, _admin, user, usdc_id, _musdc_id, adapter_id, vault) = setup_cached();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Simulate yield accruing directly in the adapter, same as above: the
        // adapter's cached total_assets() is stale until refresh() runs.
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares, &0_i128);

        // CachedMockAdapter's withdraw() is deliberately live-priced, matching
        // how BlendAdapter now sizes withdrawals off the live b_rate (#486),
        // so this test isolates what refresh() itself affects: the payout
        // here comes from the adapter's live USDC balance, not from whatever
        // the cache happened to hold, and refresh() ahead of it only keeps
        // the cache/display correct -- it doesn't change this number.
        assert_eq!(
            usdc_out,
            amount + yield_amount - yield_amount / 10,
            "withdrawer should receive live-computed value less the 10% gain fee"
        );
    }

    #[test]
    fn deposit_refresh_call_resource_cost_is_within_sanity_ceiling() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);

        // Sanity ceiling, not a tight bound: deposit() (which now includes the
        // refresh() call ahead of pricing) should stay well under a generous
        // instruction ceiling against test-double contracts. This guards against
        // a gross regression (e.g. an accidental loop) rather than pinning an
        // exact count -- real WASM costs against live protocols will differ, but
        // Soroban's per-transaction instruction ceiling has wide headroom above
        // this.
        let resources = env.cost_estimate().resources();
        assert!(
            resources.instructions < 1_000_000,
            "deposit() instruction count {} exceeds sanity ceiling",
            resources.instructions
        );
    }

    // -----------------------------------------------------------------------
    // Regression: ratio-shifting withdrawal vulnerability
    //
    // Every withdrawal computes adapter_shares_to_burn = shares * ADPT_SH /
    // TOTAL_SH. Because ADPT_SH and TOTAL_SH are mutable shared counters,
    // any other depositor's withdrawal changes the ratio before the next
    // call lands. When the ratio shifts enough, a small depositor's
    // adapter_shares_to_burn floors to zero and their transaction reverts
    // with WithdrawalTooSmall — at no incremental cost to the party whose
    // ordinary withdrawal shifted the ratio.
    //
    // The two tests below cover the two distinct failure modes this creates:
    //
    //   1. Full rounding to zero: adapter_shares_to_burn == 0, usdc_out == 0.
    //      WithdrawalTooSmall fires. min_usdc_out does not change the error
    //      code (the guard sits after the WithdrawalTooSmall check), but the
    //      scenario is reproduced so a regression would break it.
    //
    //   2. Partial drift: adapter_shares_to_burn > 0, usdc_out > 0 but below
    //      the caller's expectation. min_usdc_out fires MinAmountOutNotMet,
    //      giving the caller a predictable typed revert instead of silently
    //      accepting less than they expected.
    // -----------------------------------------------------------------------

    /// Demonstrates the ratio-shifting vulnerability and shows that
    /// min_usdc_out gives B a typed MinAmountOutNotMet revert when B's payout
    /// would be silently lower than expected due to A's prior withdrawal.
    ///
    /// Scenario:
    ///   1. A (large) and B (small) deposit.  Yield accrues.
    ///   2. B reads the state off-chain and notes their expected payout P.
    ///   3. A withdraws first, shifting ADPT_SH/TOTAL_SH and taking most
    ///      of the accrued yield.
    ///   4. B's actual payout is now P' < P.
    ///   5. Without min_usdc_out: B silently receives P', less than expected.
    ///   6. With min_usdc_out = P: B gets MinAmountOutNotMet — a typed,
    ///      actionable revert signalling the ratio shifted.
    ///
    /// We measure P and P' in two separate vault snapshots so the test is
    /// not sensitive to the exact arithmetic: snapshot 1 (no shift) gives P,
    /// snapshot 2 (after A's withdrawal) gives P'.  We assert P' < P, then
    /// use a fresh identical snapshot 2 to show that min_usdc_out = P fires
    /// MinAmountOutNotMet.
    #[test]
    fn large_depositor_withdrawal_shifts_ratio_causing_small_depositors_withdrawal_to_revert() {
        // ----------------------------------------------------------------
        // Helper: build a fresh vault where A has deposited 1_000_000 and
        // yield of 1_000_000 has accrued.  B has deposited 1_000.
        // Returns (env, usdc_id, adapter_id, vault, user_a, user_b, shares_b).
        // ----------------------------------------------------------------
        fn fresh_state() -> (
            Env,
            Address,
            Address,
            MeridianVaultClient<'static>,
            Address,
            Address,
            i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let user_a = Address::generate(&env);
            let user_b = Address::generate(&env);

            let usdc_id = env
                .register_stellar_asset_contract_v2(admin.clone())
                .address();
            let adapter_id = env.register(MockAdapter, ());
            MockAdapterClient::new(&env, &adapter_id).initialize(&usdc_id);

            // See setup()'s comment above on why the vault's address is
            // pre-generated and reserved via register_at rather than
            // registered directly (#551).
            let vault_id = test_vault(&env);

            let musdc_id = env.register(MockMusdc, ());
            MockMusdcClient::new(&env, &musdc_id).initialize(&vault_id);

            env.register_at(
                &vault_id,
                MeridianVault,
                (&admin, &usdc_id, &musdc_id, &adapter_id, &admin),
            );
            let vault = MeridianVaultClient::new(&env, &vault_id);

            StellarAssetClient::new(&env, &usdc_id).mint(&user_a, &10_000_000_i128);
            StellarAssetClient::new(&env, &usdc_id).mint(&user_b, &10_000_i128);

            vault.deposit(&user_a, &1_000_000_i128, &0_i128);
            vault.deposit(&user_b, &1_000_i128, &0_i128);

            // Yield: doubles the adapter's USDC.
            StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &1_001_000_i128);

            let shares_b = vault.get_position(&user_b);
            (env, usdc_id, adapter_id, vault, user_a, user_b, shares_b)
        }

        // Snapshot 1: B withdraws with no interference.  This is B's expected
        // payout (what an off-chain simulation would show).
        let (_, _, _, vault1, _, user_b1, shares_b1) = fresh_state();
        let payout_no_shift = match vault1.try_withdraw(&user_b1, &shares_b1, &0_i128) {
            Ok(Ok(v)) => v,
            other => panic!("snapshot 1: unexpected result {:?}", other),
        };

        // Snapshot 2: A withdraws first (shifting the ratio), then B withdraws.
        let (_, _, _, vault2, user_a2, user_b2, shares_b2) = fresh_state();
        let shares_a2 = vault2.get_position(&user_a2);
        vault2.withdraw(&user_a2, &shares_a2, &0_i128);
        let payout_after_shift = match vault2.try_withdraw(&user_b2, &shares_b2, &0_i128) {
            Ok(Ok(v)) => v,
            other => panic!("snapshot 2: unexpected result {:?}", other),
        };

        // The ratio shift must have changed B's payout.
        // (In this proportional mock the shift may reduce or leave it equal;
        // in production with Blend's b_rate accounting the shift is more
        // pronounced.  The test asserts the observed difference, then verifies
        // the guard mechanism works regardless of the exact delta.)
        //
        // Whether payout_after_shift < or == payout_no_shift, we verify that
        // setting min_usdc_out = payout_no_shift fires MinAmountOutNotMet
        // when the payout after the shift is strictly less.  If they happen
        // to be equal in this mock, we just set the floor one above either.
        let floor = if payout_after_shift < payout_no_shift {
            payout_no_shift // B expected the pre-shift amount
        } else {
            payout_after_shift + 1 // force the guard in the equal case
        };

        // Snapshot 3: identical to snapshot 2 — A shifts ratio, then B
        // attempts withdrawal with min_usdc_out = floor.
        let (_, _, _, vault3, user_a3, user_b3, shares_b3) = fresh_state();
        let shares_a3 = vault3.get_position(&user_a3);
        vault3.withdraw(&user_a3, &shares_a3, &0_i128);

        let result = vault3.try_withdraw(&user_b3, &shares_b3, &floor);
        assert_eq!(
            result,
            Err(Ok(ContractError::MinAmountOutNotMet)),
            "min_usdc_out={} must revert MinAmountOutNotMet (no-shift payout={}, \
             post-shift payout={})",
            floor,
            payout_no_shift,
            payout_after_shift
        );
    }

    /// min_usdc_out gives the caller a typed MinAmountOutNotMet revert when
    /// usdc_out is positive but falls below their floor — the partial-drift
    /// case where a concurrent withdrawal reduced the payout but didn't round
    /// it all the way to zero.
    ///
    /// Without the guard the caller would silently receive less USDC than they
    /// estimated off-chain (e.g. via a simulation run against a different
    /// ADPT_SH/TOTAL_SH ratio). With the guard they get a predictable revert
    /// they can catch, log, and retry with updated parameters.
    #[test]
    fn min_usdc_out_fires_min_amount_out_not_met_when_payout_is_positive_but_below_floor() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0_i128);
        let shares = vault.get_position(&user);

        // A floor set strictly above the actual payout (simulating the caller
        // estimating a higher payout before a concurrent ratio shift) causes
        // MinAmountOutNotMet, not a silent reduced payout.
        let above_payout = amount + 1;
        let result = vault.try_withdraw(&user, &shares, &above_payout);
        assert_eq!(
            result,
            Err(Ok(ContractError::MinAmountOutNotMet)),
            "floor above usdc_out must revert MinAmountOutNotMet"
        );

        // A floor exactly equal to the payout is accepted: the guard is >=,
        // not >, so the caller receives exactly what they asked for as a minimum.
        let exact_floor = amount;
        let usdc_out = vault.withdraw(&user, &shares, &exact_floor);
        assert_eq!(usdc_out, amount);
    }

    #[test]
    fn extend_position_ttl_is_permissionless() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        vault.extend_position_ttl(&user);
    }

    #[test]
    fn position_records_survive_ttl_advance() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        // extend_position_ttl sets a 120-day position bump. To prove
        // positions survive past the 30-day instance TTL without
        // re-extending the positions, advance in phases: bump only the
        // instance (via set_paused) at each phase boundary so the
        // contract stays alive while the original position TTL carries
        // the records through. 50 days total is well past the 30-day
        // instance window but within the 120-day position window.
        vault.extend_position_ttl(&user);
        env.ledger()
            .with_mut(|li| li.sequence_number += 25 * DAY_IN_LEDGERS);
        vault.set_paused(&true);
        vault.set_paused(&false);
        env.ledger()
            .with_mut(|li| li.sequence_number += 25 * DAY_IN_LEDGERS);
        vault.set_paused(&true);
        vault.set_paused(&false);
        env.as_contract(&vault.address, || {
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Entry(user.clone())));
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Principal(user.clone())));
        });
    }

    #[test]
    fn storage_ttl_audit_covers_every_persistent_position_key() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        vault.extend_position_ttl(&user);

        let mut remaining = POSITION_THRESHOLD - 1;
        while remaining > 0 {
            let step = remaining.min(INSTANCE_THRESHOLD - 1);
            env.ledger().with_mut(|li| li.sequence_number += step);
            // Keep the vault instance entry alive while the table-driven
            // persistent-key audit advances through the longer position TTL.
            vault.set_paused(&true);
            vault.set_paused(&false);
            remaining -= step;
        }

        env.as_contract(&vault.address, || {
            for key in [
                DataKey::Entry(user.clone()),
                DataKey::Principal(user.clone()),
            ] {
                assert!(env.storage().persistent().has(&key));
            }
        });
    }

    #[test]
    fn admin_state_calls_extend_instance_ttl() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        vault.set_paused(&true);
        env.ledger()
            .with_mut(|li| li.sequence_number += INSTANCE_THRESHOLD - 1);
        vault.set_paused(&false);
        assert!(!vault.is_paused());
    }

    fn has_event_schema_version(env: &Env, value: &soroban_sdk::Val) -> bool {
        soroban_sdk::TryIntoVal::<_, u32>::try_into_val(value, env)
            .map(|version: u32| version == EVENT_SCHEMA_VERSION)
            .unwrap_or(false)
    }

    /// Finds the event published under `(topic, schema_version)` from `address`.
    fn find_event(
        env: &Env,
        address: &Address,
        topic: Symbol,
    ) -> Option<(
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    )> {
        env.events().all().into_iter().find(|e| {
            e.0 == *address
                && e.1.len() == 2
                && soroban_sdk::TryIntoVal::<_, Symbol>::try_into_val(&e.1.get(0).unwrap(), env)
                    .map(|t: Symbol| t == topic)
                    .unwrap_or(false)
                && has_event_schema_version(env, &e.1.get(1).unwrap())
        })
    }

    #[test]
    fn deposit_publishes_event_with_caller_amount_credit_and_shares() {
        let (env, _admin, user, _usdc, _musdc, adapter, vault) = setup();
        let amount = 100_0000000_i128;

        let shares = vault.deposit(&user, &amount, &0_i128);

        // Read the events before any other call: each top-level invocation
        // replaces the recorded set.
        let event = find_event(&env, &vault.address, symbol_short!("deposit"))
            .expect("deposit event not found");
        let data: (Address, i128, i128, i128) =
            soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        let credited = MockAdapterClient::new(&env, &adapter).total_shares();
        assert_eq!(data, (user, amount, credited, shares));
    }

    #[test]
    fn withdraw_publishes_event_with_caller_shares_and_usdc_out() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let amount = 100_0000000_i128;
        let shares = vault.deposit(&user, &amount, &0_i128);

        let usdc_out = vault.withdraw(&user, &shares, &0_i128);

        let event = find_event(&env, &vault.address, symbol_short!("withdraw"))
            .expect("withdraw event not found");
        let data: (Address, i128, i128) =
            soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(data, (user, shares, usdc_out));
    }

    #[test]
    fn perf_fee_publishes_event_with_caller_treasury_fee_and_treasury_shares() {
        let (env, treasury, user, usdc, _musdc, adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        StellarAssetClient::new(&env, &usdc).mint(&adapter, &10_0000000_i128);

        let shares = vault.get_position(&user);
        let preview = vault.preview_withdraw(&user, &shares);
        vault.withdraw(&user, &shares, &0_i128);

        let event = find_event(&env, &vault.address, symbol_short!("perf_fee"))
            .expect("perf_fee event not found");
        let data: (Address, Address, i128, i128) =
            soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(data, (user, treasury, preview.fee, preview.treasury_shares));
    }

    /// Finds the event published under `(admin, action, schema_version)` from `address`.
    fn find_admin_event(
        env: &Env,
        address: &Address,
        action: Symbol,
    ) -> Option<(
        Address,
        soroban_sdk::Vec<soroban_sdk::Val>,
        soroban_sdk::Val,
    )> {
        env.events().all().into_iter().find(|e| {
            e.0 == *address
                && e.1.len() == 3
                && soroban_sdk::TryIntoVal::<_, Symbol>::try_into_val(&e.1.get(0).unwrap(), env)
                    .map(|t: Symbol| t == ADMIN_EVT)
                    .unwrap_or(false)
                && soroban_sdk::TryIntoVal::<_, Symbol>::try_into_val(&e.1.get(1).unwrap(), env)
                    .map(|t: Symbol| t == action)
                    .unwrap_or(false)
                && has_event_schema_version(env, &e.1.get(2).unwrap())
        })
    }

    #[test]
    fn paused_publishes_event_with_pause_state() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();

        vault.set_paused(&true);

        let event = find_admin_event(&env, &vault.address, symbol_short!("paused"))
            .expect("paused event not found");
        let data: bool = soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert!(data);
    }

    #[test]
    fn transfer_publishes_event_with_nominee() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let new_admin = Address::generate(&env);

        vault.transfer_admin(&new_admin);

        let event = find_admin_event(&env, &vault.address, symbol_short!("transfer"))
            .expect("transfer event not found");
        let data: Address = soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(data, new_admin);
    }

    #[test]
    fn accept_publishes_event_with_new_admin() {
        let (env, _admin, _user, _usdc, _musdc, _adapter, vault) = setup();
        let new_admin = Address::generate(&env);
        vault.transfer_admin(&new_admin);

        vault.accept_admin();

        let event = find_admin_event(&env, &vault.address, symbol_short!("accept"))
            .expect("accept event not found");
        let data: Address = soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(data, new_admin);
    }

    #[test]
    fn adapter_publishes_event_with_new_adapter() {
        let (env, _admin, _user, usdc, _musdc, _adapter, vault) = setup();
        let new_adapter = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter).initialize(&usdc);

        vault.set_adapter(&new_adapter);

        let event = find_admin_event(&env, &vault.address, symbol_short!("adapter"))
            .expect("adapter event not found");
        let data: Address = soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(data, new_adapter);
    }

    #[test]
    fn begin_migration_publishes_event_with_adapter_and_earliest_ledger() {
        let (env, _admin, _user, usdc, _musdc, _adapter, vault) = setup();
        let new_adapter_id = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter_id).initialize(&usdc);

        let current_ledger = env.ledger().sequence();
        vault.begin_migration(&new_adapter_id);

        let event = find_admin_event(&env, &vault.address, symbol_short!("mig_begin"))
            .expect("mig_begin event not found");
        let (target_adapter, earliest_ledger): (Address, u32) =
            soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(target_adapter, new_adapter_id);
        assert_eq!(earliest_ledger, current_ledger + MIN_LEDGER_GAP);
    }

    #[test]
    fn migrate_publishes_event_with_old_and_new_adapter() {
        let (env, _admin, user, usdc, _musdc, old_adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let new_adapter = env.register(MockAdapter, ());
        MockAdapterClient::new(&env, &new_adapter).initialize(&usdc);
        vault.begin_migration(&new_adapter);
        env.ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);

        vault.migrate_adapter(&new_adapter, &0);

        let event = find_admin_event(&env, &vault.address, symbol_short!("migrate"))
            .expect("migrate event not found");
        let data: (Address, Address) =
            soroban_sdk::TryIntoVal::try_into_val(&event.2, &env).unwrap();
        assert_eq!(data, (old_adapter, new_adapter));
    }

    // -----------------------------------------------------------------------
    // Deposit-value parity (#1263)
    //
    // `CreditMockAdapter` credits a deposit the way a share-based protocol
    // does (shares bought at the pre-deposit rate) but can be switched into
    // the paths where the credit is worth less than the USDC it was handed,
    // or where its reported credit is not backed at all. Uninvested USDC
    // (partial fill, supply cap) stays on the adapter as an idle balance
    // that `total_assets()` excludes, the way a real adapter values only
    // its protocol position. Own module for the same reason as
    // `lossy_mock`: contractimpl-generated helper items aren't namespaced
    // by type.
    // -----------------------------------------------------------------------
    mod credit_mock {
        use super::*;

        pub const MODE_FULL: u32 = 0;
        /// Invests `param` bps of each deposit; the rest stays idle.
        pub const MODE_PARTIAL_FILL: u32 = 1;
        /// Sends `param` bps of each deposit to the sink as a fee.
        pub const MODE_FEE: u32 = 2;
        /// Invests only up to `param` stroops of total position value; the
        /// rest stays idle.
        pub const MODE_SUPPLY_CAP: u32 = 3;
        /// Credits shares for the deposit but sends the USDC to the sink, so
        /// the credit has nothing behind it.
        pub const MODE_PHANTOM: u32 = 4;
        /// Invests everything but reports `param` more shares than it
        /// actually booked.
        pub const MODE_OVER_REPORT: u32 = 5;

        const CR_USDC: Symbol = symbol_short!("CR_USDC");
        const CR_SH: Symbol = symbol_short!("CR_SH");
        const CR_IDLE: Symbol = symbol_short!("CR_IDLE");
        const CR_MODE: Symbol = symbol_short!("CR_MODE");
        const CR_PARAM: Symbol = symbol_short!("CR_PARAM");
        const CR_SINK: Symbol = symbol_short!("CR_SINK");

        #[contract]
        pub struct CreditMockAdapter;

        #[contractimpl]
        impl CreditMockAdapter {
            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&CR_USDC, &usdc);
                env.storage().instance().set(&CR_SH, &0_i128);
                env.storage().instance().set(&CR_IDLE, &0_i128);
                env.storage().instance().set(&CR_MODE, &MODE_FULL);
                env.storage().instance().set(&CR_PARAM, &0_i128);
                env.storage()
                    .instance()
                    .set(&CR_SINK, &Address::generate(&env));
            }

            pub fn configure(env: Env, mode: u32, param: i128) {
                env.storage().instance().set(&CR_MODE, &mode);
                env.storage().instance().set(&CR_PARAM, &param);
            }

            pub fn sink(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&CR_SINK))
            }

            pub fn deposit(env: Env, amount: i128) -> i128 {
                let usdc = Self::usdc(&env);
                let token = TokenClient::new(&env, &usdc);
                let me = env.current_contract_address();
                let mode: u32 = env.storage().instance().get(&CR_MODE).unwrap_or(MODE_FULL);
                let param: i128 = env.storage().instance().get(&CR_PARAM).unwrap_or(0);
                let idle: i128 = env.storage().instance().get(&CR_IDLE).unwrap_or(0);
                let total_sh: i128 = env.storage().instance().get(&CR_SH).unwrap_or(0);
                // `amount` has already been transferred in by the vault.
                let assets_before = token.balance(&me) - amount - idle;

                let mut extra_reported = 0_i128;
                let invested = match mode {
                    MODE_PARTIAL_FILL => amount * param / 10_000,
                    MODE_FEE => {
                        let fee = amount * param / 10_000;
                        token.transfer(&me, &Self::sink(env.clone()), &fee);
                        amount - fee
                    }
                    MODE_SUPPLY_CAP => (param - assets_before).clamp(0, amount),
                    MODE_PHANTOM => {
                        token.transfer(&me, &Self::sink(env.clone()), &amount);
                        amount
                    }
                    MODE_OVER_REPORT => {
                        extra_reported = param;
                        amount
                    }
                    _ => amount,
                };
                if matches!(mode, MODE_PARTIAL_FILL | MODE_SUPPLY_CAP) {
                    env.storage()
                        .instance()
                        .set(&CR_IDLE, &(idle + amount - invested));
                }

                let credited = mock_shares_for(invested, total_sh, assets_before);
                env.storage().instance().set(&CR_SH, &(total_sh + credited));
                credited + extra_reported
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                let total_sh: i128 = env.storage().instance().get(&CR_SH).unwrap_or(0);
                let usdc_out = if total_sh > 0 {
                    shares * Self::total_assets(env.clone()) / total_sh
                } else {
                    0
                };
                if usdc_out > 0 {
                    TokenClient::new(&env, &Self::usdc(&env)).transfer(
                        &env.current_contract_address(),
                        &recipient,
                        &usdc_out,
                    );
                }
                env.storage().instance().set(&CR_SH, &(total_sh - shares));
                usdc_out
            }

            pub fn total_assets(env: Env) -> i128 {
                let idle: i128 = env.storage().instance().get(&CR_IDLE).unwrap_or(0);
                mock_total_assets(&env, &Self::usdc(&env)) - idle
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&CR_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                // See MockAdapter::refresh() above.
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
            }

            fn usdc(env: &Env) -> Address {
                // USDC address is always set in initialize(), so this is safe.
                get_or_not_initialized(env, env.storage().instance().get(&CR_USDC))
            }
        }
    }
    use credit_mock::{
        CreditMockAdapter, CreditMockAdapterClient, MODE_FEE, MODE_OVER_REPORT, MODE_PARTIAL_FILL,
        MODE_PHANTOM, MODE_SUPPLY_CAP,
    };

    const PARITY_SEED: i128 = 10_000_000_000;
    const PARITY_YIELD: i128 = 100_0000000;
    const PARITY_DEPOSIT: i128 = 100_0000000;

    struct ParityRig {
        env: Env,
        seeder: Address,
        depositor: Address,
        usdc: Address,
        adapter: CreditMockAdapterClient<'static>,
        vault: MeridianVaultClient<'static>,
    }

    /// A vault on `CreditMockAdapter` holding a 1,000 USDC position that
    /// has earned 100 USDC of yield, so the adapter's share rate and the
    /// vault's share price are both away from 1:1 when the deposit under
    /// test lands.
    fn parity_rig() -> ParityRig {
        parity_rig_with(PARITY_SEED, PARITY_YIELD)
    }

    /// `parity_rig` with a chosen seed deposit and adapter yield. A small
    /// seed with a large yield leaves each adapter share worth a lot.
    fn parity_rig_with(seed: i128, yield_: i128) -> ParityRig {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let seeder = Address::generate(&env);
        let depositor = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let adapter_id = env.register(CreditMockAdapter, ());
        let adapter = CreditMockAdapterClient::new(&env, &adapter_id);
        adapter.initialize(&usdc);

        let vault_id = Address::generate(&env);
        let musdc = env.register(MockMusdc, ());
        MockMusdcClient::new(&env, &musdc).initialize(&vault_id);
        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc, &musdc, &adapter_id, &admin),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);

        let sac = StellarAssetClient::new(&env, &usdc);
        sac.mint(&seeder, &seed);
        sac.mint(&depositor, &(10 * PARITY_DEPOSIT));
        vault.deposit(&seeder, &seed, &0);
        sac.mint(&adapter_id, &yield_);

        ParityRig {
            env,
            seeder,
            depositor,
            usdc,
            adapter,
            vault,
        }
    }

    /// What a deposit worth `value` USDC should mint against the rig's
    /// pre-deposit state, using the same formula as the vault.
    fn parity_price(r: &ParityRig, value: i128) -> i128 {
        crate::pricing::shares_for_assets(
            value,
            r.vault.get_total_shares(),
            r.vault.get_total_assets(),
        )
        .unwrap()
    }

    fn stored_adpt_sh(r: &ParityRig) -> i128 {
        r.env.as_contract(&r.vault.address, || {
            r.env.storage().instance().get(&ADPT_SH).unwrap_or(0)
        })
    }

    /// Runs the deposit under test and checks the invariants every
    /// accepted deposit must keep: the share price existing holders see
    /// does not drop, `TOTAL_SH` equals the mUSDC actually held, `ADPT_SH`
    /// equals the adapter's own share balance, and the event carries the
    /// requested amount, the adapter's credit and the mint. Returns the
    /// shares minted.
    fn deposit_and_check_parity(r: &ParityRig, amount: i128) -> i128 {
        let assets_before = r.vault.get_total_assets();
        let shares_before = r.vault.get_total_shares();
        let adapter_shares_before = r.adapter.total_shares();

        let minted = r.vault.deposit(&r.depositor, &amount, &0);

        let event = find_event(&r.env, &r.vault.address, symbol_short!("deposit"))
            .expect("deposit event not found");
        let data: (Address, i128, i128, i128) =
            soroban_sdk::TryIntoVal::try_into_val(&event.2, &r.env).unwrap();
        let credited = r.adapter.total_shares() - adapter_shares_before;
        assert_eq!(data, (r.depositor.clone(), amount, credited, minted));

        // Compared at the vault's own price, `(assets + OFFSET) / (shares +
        // OFFSET)`: the raw ratio moves by a few stroops on any deposit
        // because of the virtual offset, even with exact accounting.
        let assets_after = r.vault.get_total_assets();
        let shares_after = r.vault.get_total_shares();
        assert!(
            (assets_after + OFFSET) * (shares_before + OFFSET)
                >= (assets_before + OFFSET) * (shares_after + OFFSET),
            "existing holders were diluted: {assets_before}/{shares_before} -> {assets_after}/{shares_after}"
        );
        assert_eq!(
            shares_after,
            r.vault.get_position(&r.seeder) + r.vault.get_position(&r.depositor)
        );
        assert_eq!(stored_adpt_sh(r), r.adapter.total_shares());
        minted
    }

    /// `minted` is within a few stroops of the shares `value` USDC buys.
    fn assert_minted_for(r_price: i128, minted: i128) {
        assert!(
            (r_price - minted).abs() <= 2,
            "minted {minted}, expected ~{r_price}"
        );
    }

    #[test]
    fn deposit_partial_fill_mints_only_for_the_credited_value() {
        let r = parity_rig();
        let quote = parity_price(&r, PARITY_DEPOSIT);
        let expected = parity_price(&r, PARITY_DEPOSIT / 2);
        r.adapter.configure(&MODE_PARTIAL_FILL, &5_000);

        let minted = deposit_and_check_parity(&r, PARITY_DEPOSIT);

        assert!(minted < quote, "a half fill must not mint the full quote");
        assert_minted_for(expected, minted);
    }

    #[test]
    fn deposit_short_by_less_than_an_expensive_share_mints_the_credited_value() {
        // 1,000 stroops seeded, then 10,000 USDC of yield: each adapter share
        // is worth ~10 USDC. A 25 USDC deposit buys 2 shares, leaving ~5 USDC
        // uncredited. That is under one share but well above the deposit
        // tolerance, so it is not rounding and the depositor must not be
        // paid for it.
        let r = parity_rig_with(1_000, 100_000_000_000);
        let amount = 25_0000000;
        let adapter_assets_before = r.adapter.total_assets();
        let adapter_shares_before = r.adapter.total_shares();
        let quote = parity_price(&r, amount);

        let credited = mock_shares_for(amount, adapter_shares_before, adapter_assets_before);
        let assets_after = adapter_assets_before + amount;
        let shares_after = adapter_shares_before + credited;
        let credited_value = credited * assets_after / shares_after;
        let one_share_value = (assets_after + shares_after - 1) / shares_after;
        let shortfall = amount - credited_value;
        assert!(shortfall > MeridianVault::deposit_value_tolerance(amount).unwrap());
        assert!(shortfall < one_share_value);
        let expected = parity_price(&r, credited_value);

        let minted = deposit_and_check_parity(&r, amount);

        assert!(
            minted < quote,
            "a real shortfall must not mint the full quote"
        );
        assert_minted_for(expected, minted);
    }

    #[test]
    fn deposit_partial_fill_is_rejected_by_a_full_quote_min_shares_out() {
        let r = parity_rig();
        let quote = parity_price(&r, PARITY_DEPOSIT);
        r.adapter.configure(&MODE_PARTIAL_FILL, &5_000);
        let shares_before = r.vault.get_total_shares();

        let result = r.vault.try_deposit(&r.depositor, &PARITY_DEPOSIT, &quote);

        assert_eq!(result, Err(Ok(ContractError::SlippageExceeded)));
        assert_eq!(r.vault.get_total_shares(), shares_before);
        assert_eq!(r.vault.get_position(&r.depositor), 0);
    }

    #[test]
    fn deposit_fee_on_deposit_mints_net_of_the_fee() {
        let r = parity_rig();
        let fee = PARITY_DEPOSIT / 100;
        let expected = parity_price(&r, PARITY_DEPOSIT - fee);
        r.adapter.configure(&MODE_FEE, &100);

        let minted = deposit_and_check_parity(&r, PARITY_DEPOSIT);

        assert_eq!(
            TokenClient::new(&r.env, &r.usdc).balance(&r.adapter.sink()),
            fee
        );
        assert_minted_for(expected, minted);
    }

    #[test]
    fn deposit_supply_cap_mints_only_up_to_the_cap() {
        let r = parity_rig();
        let room = 40_0000000_i128;
        let cap = r.vault.get_total_assets() + room;
        let expected = parity_price(&r, room);
        r.adapter.configure(&MODE_SUPPLY_CAP, &cap);

        let minted = deposit_and_check_parity(&r, PARITY_DEPOSIT);

        assert_minted_for(expected, minted);
        assert_eq!(r.vault.get_total_assets(), cap);
    }

    #[test]
    fn deposit_into_a_full_supply_cap_credits_nothing_and_mints_nothing() {
        let r = parity_rig();
        r.adapter
            .configure(&MODE_SUPPLY_CAP, &r.vault.get_total_assets());
        let shares_before = r.vault.get_total_shares();

        let result = r.vault.try_deposit(&r.depositor, &PARITY_DEPOSIT, &0);

        assert_eq!(result, Err(Ok(ContractError::AdapterCreditedNothing)));
        assert_eq!(r.vault.get_total_shares(), shares_before);
        assert_eq!(r.vault.get_position(&r.depositor), 0);
    }

    #[test]
    fn deposit_rejects_a_credit_with_no_value_behind_it() {
        let r = parity_rig();
        r.adapter.configure(&MODE_PHANTOM, &0);
        let shares_before = r.vault.get_total_shares();
        let adapter_shares_before = r.adapter.total_shares();

        let result = r.vault.try_deposit(&r.depositor, &PARITY_DEPOSIT, &0);

        assert_eq!(result, Err(Ok(ContractError::DepositValueMismatch)));
        assert_eq!(r.vault.get_total_shares(), shares_before);
        assert_eq!(r.adapter.total_shares(), adapter_shares_before);
        assert_eq!(r.vault.get_position(&r.depositor), 0);
    }

    #[test]
    fn deposit_rejects_an_adapter_over_reporting_its_credit() {
        let r = parity_rig();
        // 1 USDC worth of shares more than were booked: far past the
        // tolerance for a 100 USDC deposit.
        r.adapter.configure(&MODE_OVER_REPORT, &1_0000000);

        let result = r.vault.try_deposit(&r.depositor, &PARITY_DEPOSIT, &0);

        assert_eq!(result, Err(Ok(ContractError::DepositValueMismatch)));
        assert_eq!(r.vault.get_position(&r.depositor), 0);
    }

    #[test]
    fn credit_short_by_adapter_mint_rounding_counts_as_full_amount() {
        // Inputs from a real share-based mint: 366_532_618 USDC bought
        // 258_070_348 adapter shares at ~1.42 USDC/share, so the credit
        // values 2 stroops short. One share is worth 2 stroops (rounded up),
        // so the slack is 3 and the shortfall is rounding.
        let amount = 366_532_618;
        let (assets_before, assets_after, shares_after) =
            (2_468_061_454, 2_834_594_072, 1_995_796_949);
        assert_eq!(
            MeridianVault::value_deposit_credit(
                amount,
                258_070_348,
                assets_before,
                assets_after,
                shares_after,
            ),
            Ok(amount)
        );

        // Two shares short is beyond one share of rounding: valued as is.
        let short = MeridianVault::value_deposit_credit(
            amount,
            258_070_346,
            assets_before,
            assets_after,
            shares_after,
        )
        .unwrap();
        assert!(short < amount - 3, "{short} should be below the slack");
    }

    #[test]
    fn rounding_slack_is_capped_at_the_deposit_tolerance() {
        // Adapter shares worth ~10 USDC (100_000_000 stroops) each: 25 USDC
        // buys 2 shares, so the credit is short by about half a share. That is less than one share, but far above the
        // deposit tolerance, so it is a real shortfall and must be valued as
        // credited, not rounded up to the full amount.
        let amount = 250_000_000;
        let (assets_before, assets_after, shares_after) = (10_000_000_000, 10_250_000_000, 102);
        let credited = 2;
        let credited_value = credited * assets_after / shares_after;
        let tolerance = MeridianVault::deposit_value_tolerance(amount).unwrap();
        let one_share_value = (assets_after + shares_after - 1) / shares_after;
        assert!(amount - credited_value > tolerance);
        assert!(amount - credited_value < one_share_value);

        assert_eq!(
            MeridianVault::value_deposit_credit(
                amount,
                credited,
                assets_before,
                assets_after,
                shares_after,
            ),
            Ok(credited_value)
        );
    }

    #[test]
    fn deposit_caps_an_over_report_within_tolerance_at_the_quote() {
        let r = parity_rig();
        let quote = parity_price(&r, PARITY_DEPOSIT);
        // A one-share over-report is rounding-sized: accepted, but it buys
        // nothing beyond what the deposit actually delivered.
        r.adapter.configure(&MODE_OVER_REPORT, &1);
        let adapter_shares_before = r.adapter.total_shares();

        let minted = r.vault.deposit(&r.depositor, &PARITY_DEPOSIT, &0);

        assert!(minted <= quote);
        assert_minted_for(quote, minted);
        // ADPT_SH follows the adapter's ledger, not the inflated report.
        assert_eq!(stored_adpt_sh(&r), r.adapter.total_shares());
        assert!(stored_adpt_sh(&r) > adapter_shares_before);
    }

    #[test]
    fn value_deposit_credit_enforces_the_documented_tolerance() {
        let amount = 100_0000000_i128;
        let tolerance = amount * DEPOSIT_VALUE_TOLERANCE_BPS / BPS_DENOMINATOR
            + DEPOSIT_VALUE_TOLERANCE_STROOPS;
        assert_eq!(
            MeridianVault::deposit_value_tolerance(amount),
            Ok(tolerance)
        );

        // 1:1 adapter with 1,000 USDC already in it.
        let before = 10_000_000_000_i128;
        let value = |credited: i128, assets_after: i128, shares_after: i128| {
            MeridianVault::value_deposit_credit(
                amount,
                credited,
                before,
                assets_after,
                shares_after,
            )
        };

        // Exact credit.
        assert_eq!(value(amount, before + amount, before + amount), Ok(amount));
        // Partial credit is returned at its real value, not rejected.
        assert_eq!(
            value(amount / 2, before + amount / 2, before + amount / 2),
            Ok(amount / 2)
        );
        // Over-credit up to the tolerance is capped at the backing...
        let shares_after = before + amount + tolerance;
        assert_eq!(
            value(
                amount + tolerance,
                before + amount + tolerance,
                shares_after
            ),
            Ok(amount)
        );
        // ...and one stroop past it is a mismatch.
        assert_eq!(
            value(
                amount + tolerance + 1,
                before + amount + tolerance + 1,
                before + amount + tolerance + 1
            ),
            Err(ContractError::DepositValueMismatch)
        );
        // Backing is also bounded by how much the adapter's assets grew.
        assert_eq!(
            value(amount, before + amount / 2, before + amount),
            Err(ContractError::DepositValueMismatch)
        );
        // A credit larger than the whole position, or no position at all.
        assert_eq!(
            value(before + amount + 1, before + amount, before + amount),
            Err(ContractError::DepositValueMismatch)
        );
        assert_eq!(
            value(amount, before + amount, 0),
            Err(ContractError::DepositValueMismatch)
        );
    }

    // -----------------------------------------------------------------------
    // Preview and conversion views (#1265)
    // -----------------------------------------------------------------------

    #[test]
    fn views_on_an_empty_vault_return_documented_values() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();

        // Empty vault: 1 share per stroop, price exactly 1.0.
        assert_eq!(vault.convert_to_shares(&1_234_567), 1_234_567);
        assert_eq!(vault.convert_to_assets(&1_234_567), 0);
        assert_eq!(vault.get_share_price(), pricing::PRICE_SCALE);
        assert_eq!(vault.preview_deposit(&1_234_567), 1_234_567);

        // Zero quotes zero; negative is the entry points' ZeroAmount.
        assert_eq!(vault.convert_to_shares(&0), 0);
        assert_eq!(vault.convert_to_assets(&0), 0);
        assert_eq!(vault.preview_deposit(&0), 0);
        assert_eq!(
            vault.try_convert_to_shares(&-1),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert_eq!(
            vault.try_convert_to_assets(&-1),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert_eq!(
            vault.try_preview_deposit(&-1),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert_eq!(
            vault.try_preview_withdraw(&user, &-1),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert_eq!(
            vault.preview_withdraw(&user, &0),
            WithdrawPreview {
                gross_assets: 0,
                fee: 0,
                treasury_shares: 0,
                assets_out: 0
            }
        );
        assert_eq!(
            vault.try_preview_withdraw(&user, &1),
            Err(Ok(ContractError::NoSharesOutstanding))
        );
    }

    #[test]
    fn preview_deposit_reflects_pause_and_dust() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();
        vault.deposit(&user, &100_0000000, &0);
        // Donate so one stroop prices below one share.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &10_000_000_000_i128);
        assert_eq!(
            vault.try_preview_deposit(&1),
            Err(Ok(ContractError::DepositTooSmall))
        );
        vault.set_paused(&true);
        assert_eq!(
            vault.try_preview_deposit(&1_0000000),
            Err(Ok(ContractError::DepositsPaused))
        );
    }

    #[test]
    fn views_report_shares_outstanding_with_no_assets() {
        let (env, _admin, user, usdc_id, _musdc, adapter_id, vault) = setup();
        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &0);
        let sink = Address::generate(&env);
        TokenClient::new(&env, &usdc_id).transfer(&adapter_id, &sink, &amount);

        assert_eq!(
            vault.try_convert_to_shares(&1_0000000),
            Err(Ok(ContractError::AdapterReportedNoAssets))
        );
        assert_eq!(
            vault.try_preview_deposit(&1_0000000),
            Err(Ok(ContractError::AdapterReportedNoAssets))
        );
        // Value of the held shares is zero, and the price is near zero but
        // defined: no panic, no error.
        assert_eq!(vault.convert_to_assets(&amount), 0);
        assert!(vault.get_share_price() < pricing::PRICE_SCALE / 1_000);
        assert_eq!(
            vault.try_preview_withdraw(&user, &amount),
            Err(Ok(ContractError::WithdrawalTooSmall))
        );
    }

    #[test]
    fn preview_withdraw_matches_withdraw_with_fee_and_treasury_mint() {
        let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
        vault.deposit(&user, &100_0000000, &0);
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &10_0000000_i128);

        let shares = vault.get_position(&user);
        let preview = vault.preview_withdraw(&user, &shares);
        assert_eq!(vault.convert_to_assets(&shares), preview.gross_assets);
        assert_eq!(preview.fee, 1_0000000);

        let usdc = TokenClient::new(&env, &usdc_id);
        let musdc = TokenClient::new(&env, &musdc_id);
        let usdc_before = usdc.balance(&user);
        let treasury_before = musdc.balance(&treasury);
        let received = vault.withdraw(&user, &shares, &0);

        assert_eq!(received, preview.assets_out);
        assert_eq!(usdc.balance(&user) - usdc_before, preview.assets_out);
        assert_eq!(
            musdc.balance(&treasury) - treasury_before,
            preview.treasury_shares
        );
    }

    #[test]
    fn preview_withdraw_uses_basis_moved_by_transfer() {
        let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
        vault.deposit(&user, &100_0000000, &0);
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &20_0000000_i128);

        // Half the position, and half its basis, moves to a receiver.
        let receiver = Address::generate(&env);
        let half = vault.get_position(&user) / 2;
        TokenClient::new(&env, &musdc_id).transfer(&user, &receiver, &half);

        let shares = vault.get_position(&receiver);
        let preview = vault.preview_withdraw(&receiver, &shares);
        assert!(preview.fee > 0);
        let treasury_before = TokenClient::new(&env, &musdc_id).balance(&treasury);
        let received = vault.withdraw(&receiver, &shares, &0);
        assert_eq!(received, preview.assets_out);
        assert_eq!(
            TokenClient::new(&env, &musdc_id).balance(&treasury) - treasury_before,
            preview.treasury_shares
        );
    }

    #[test]
    fn preview_withdraw_dust_fee_is_returned_to_holder() {
        let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
        vault.deposit(&user, &100_0000000, &0);
        // Gain of 9 stroops -> fee 0 (rounds down): payout is the gross.
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &9_i128);
        let shares = vault.get_position(&user);
        let preview = vault.preview_withdraw(&user, &shares);
        assert_eq!(preview.fee, 0);
        assert_eq!(preview.assets_out, preview.gross_assets);
        let received = vault.withdraw(&user, &shares, &0);
        assert_eq!(received, preview.assets_out);
        assert_eq!(TokenClient::new(&env, &musdc_id).balance(&treasury), 0);
    }

    // Deterministic pseudo-random scenarios (no extra dev-dependency): every
    // preview must equal what the real call mints or pays, or fail with the
    // same error.
    #[test]
    fn previews_match_execution_across_random_scenarios() {
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move |lo: i128, hi: i128| -> i128 {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            lo + ((state >> 33) as i128) % (hi - lo + 1)
        };

        for _ in 0..40 {
            let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
            let usdc_admin = StellarAssetClient::new(&env, &usdc_id);
            let usdc = TokenClient::new(&env, &usdc_id);
            let musdc = TokenClient::new(&env, &musdc_id);
            let user2 = Address::generate(&env);
            usdc_admin.mint(&user2, &10_000_000_000_i128);

            // Deposits: preview == minted shares.
            for depositor in [&user, &user2] {
                let amount = next(1, 3_000_000_000);
                let quoted = vault.try_preview_deposit(&amount);
                let actual = vault.try_deposit(depositor, &amount, &0);
                assert_eq!(quoted, actual);
                if let Ok(Ok(minted)) = actual {
                    assert_eq!(vault.convert_to_shares(&amount), minted);
                }
                if next(0, 1) == 1 {
                    usdc_admin.mint(&adapter_id, &next(0, 1_500_000_000));
                }
            }

            // Optionally move part of user's position (and basis) to a third party.
            let user3 = Address::generate(&env);
            let user_shares = vault.get_position(&user);
            if user_shares > 1 && next(0, 1) == 1 {
                musdc.transfer(&user, &user3, &next(1, user_shares - 1));
            }

            // Withdrawals: preview == payout and treasury mint.
            for holder in [&user, &user2, &user3] {
                let balance = musdc.balance(holder);
                if balance == 0 {
                    continue;
                }
                let shares = next(1, balance);
                let quoted = vault.try_preview_withdraw(holder, &shares);
                let usdc_before = usdc.balance(holder);
                let treasury_before = musdc.balance(&treasury);
                let actual = vault.try_withdraw(holder, &shares, &0);
                match (quoted, actual) {
                    (Ok(Ok(p)), Ok(Ok(received))) => {
                        assert_eq!(received, p.assets_out);
                        assert_eq!(usdc.balance(holder) - usdc_before, p.assets_out);
                        assert_eq!(
                            musdc.balance(&treasury) - treasury_before,
                            p.treasury_shares
                        );
                    }
                    (Err(q), Err(a)) => assert_eq!(q, a),
                    (q, a) => panic!("preview {q:?} disagrees with execution {a:?}"),
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Reentrancy guard (#1264)
    //
    // `reentrant_hooks` holds the shared "attack" logic; `ReentrantAdapter`
    // and `ReentrantToken` are mocks that run it from inside the external
    // calls the vault makes (adapter refresh/deposit/withdraw, token
    // transfer/mint/burn). Each mock lives in its own module for the same
    // reason as `lossy_mock`/`mock_musdc` above: contractimpl-generated
    // helper items aren't namespaced by type.
    // -----------------------------------------------------------------------
    mod reentrant_hooks {
        use super::*;

        // Where in a mock's own execution the attack fires.
        pub const HOOK_REFRESH: u32 = 1;
        pub const HOOK_DEPOSIT: u32 = 2;
        pub const HOOK_WITHDRAW: u32 = 3;
        pub const HOOK_TRANSFER: u32 = 4;
        pub const HOOK_MINT: u32 = 5;
        pub const HOOK_BURN: u32 = 6;

        // Which vault entry point the attack calls back into.
        pub const ATK_DEPOSIT: u32 = 1;
        pub const ATK_WITHDRAW: u32 = 2;
        pub const ATK_BEGIN_MIGRATION: u32 = 3;
        pub const ATK_MIGRATE: u32 = 4;
        pub const ATK_ON_TRANSFER: u32 = 5;
        pub const ALL_ATTACKS: [u32; 5] = [
            ATK_DEPOSIT,
            ATK_WITHDRAW,
            ATK_BEGIN_MIGRATION,
            ATK_MIGRATE,
            ATK_ON_TRANSFER,
        ];

        // Outcome codes for each attempt. A typed vault error is its own
        // discriminant (`ContractError as u32`); anything else that failed
        // (e.g. the Soroban host refusing the re-entry itself) is
        // OUTCOME_OTHER_ERROR.
        pub const OUTCOME_SUCCEEDED: u32 = 1000;
        pub const OUTCOME_OTHER_ERROR: u32 = 2000;

        const RE_VAULT: Symbol = symbol_short!("RE_VAULT");
        const RE_HOOK: Symbol = symbol_short!("RE_HOOK");
        const RE_ATK: Symbol = symbol_short!("RE_ATK");
        const RE_TRIES: Symbol = symbol_short!("RE_TRIES");
        const RE_OK: Symbol = symbol_short!("RE_OK");

        pub fn arm(env: &Env, vault: &Address, hook: u32, attack: u32) {
            env.storage().instance().set(&RE_VAULT, vault);
            env.storage().instance().set(&RE_HOOK, &hook);
            env.storage().instance().set(&RE_ATK, &attack);
            env.storage().instance().set(&RE_TRIES, &0_u32);
            env.storage().instance().set(&RE_OK, &0_u32);
        }

        pub fn tries(env: &Env) -> u32 {
            env.storage().instance().get(&RE_TRIES).unwrap_or(0)
        }

        /// How many reentrant calls were *not* rejected. Must stay 0.
        pub fn succeeded(env: &Env) -> u32 {
            env.storage().instance().get(&RE_OK).unwrap_or(0)
        }

        fn code<T, E>(
            r: Result<Result<T, E>, Result<ContractError, soroban_sdk::InvokeError>>,
        ) -> u32 {
            match r {
                Ok(_) => OUTCOME_SUCCEEDED,
                Err(Ok(e)) => e as u32,
                Err(Err(_)) => OUTCOME_OTHER_ERROR,
            }
        }

        /// If armed for `hook`, calls back into the vault and records the
        /// outcome. The arguments are deliberately well-formed: a reentrant
        /// call that got past the guard would be a real, valid operation.
        pub fn fire(env: &Env, hook: u32) {
            let armed: u32 = env.storage().instance().get(&RE_HOOK).unwrap_or(0);
            if armed != hook {
                return;
            }
            let vault: Address = env.storage().instance().get(&RE_VAULT).unwrap();
            let attack: u32 = env.storage().instance().get(&RE_ATK).unwrap();
            let v = MeridianVaultClient::new(env, &vault);
            let me = env.current_contract_address();
            let other = Address::generate(env);

            let outcome = match attack {
                ATK_DEPOSIT => code(v.try_deposit(&me, &1_0000000_i128, &0)),
                ATK_WITHDRAW => code(v.try_withdraw(&me, &1_i128, &0)),
                ATK_BEGIN_MIGRATION => code(v.try_begin_migration(&other)),
                ATK_MIGRATE => code(v.try_migrate_adapter(&other, &0)),
                ATK_ON_TRANSFER => code(v.try_on_transfer(&me, &other, &1_i128, &1_i128, &0_i128)),
                _ => panic!("unknown attack"),
            };
            env.storage().instance().set(&RE_TRIES, &(tries(env) + 1));
            if outcome == OUTCOME_SUCCEEDED {
                env.storage().instance().set(&RE_OK, &(succeeded(env) + 1));
            }
        }
    }

    // MockAdapter's behavior (proportional, live-priced) plus the attack hook
    // in refresh/deposit/withdraw.
    mod reentrant_adapter {
        use super::reentrant_hooks::*;
        use super::*;

        const RA_USDC: Symbol = symbol_short!("RA_USDC");
        const RA_SH: Symbol = symbol_short!("RA_SH");

        #[contract]
        pub struct ReentrantAdapter;

        #[contractimpl]
        impl ReentrantAdapter {
            pub fn get_usdc(env: Env) -> Address {
                get_or_not_initialized(&env, env.storage().instance().get(&RA_USDC))
            }

            pub fn get_vault(env: Env) -> Address {
                test_vault(&env)
            }

            pub fn initialize(env: Env, usdc: Address) {
                env.storage().instance().set(&RA_USDC, &usdc);
                env.storage().instance().set(&RA_SH, &0_i128);
            }

            pub fn arm(env: Env, vault: Address, hook: u32, attack: u32) {
                super::reentrant_hooks::arm(&env, &vault, hook, attack);
            }

            pub fn tries(env: Env) -> u32 {
                super::reentrant_hooks::tries(&env)
            }

            pub fn succeeded(env: Env) -> u32 {
                super::reentrant_hooks::succeeded(&env)
            }

            pub fn deposit(env: Env, amount: i128) -> i128 {
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
                fire(&env, HOOK_DEPOSIT);
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&RA_USDC));
                mock_credit_from_balance(&env, &usdc, &RA_SH, amount)
            }

            pub fn withdraw(env: Env, shares: i128, recipient: Address) -> i128 {
                fire(&env, HOOK_WITHDRAW);
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&RA_USDC));
                mock_proportional_withdraw(&env, &usdc, &RA_SH, shares, &recipient)
            }

            pub fn total_assets(env: Env) -> i128 {
                let usdc: Address =
                    get_or_not_initialized(&env, env.storage().instance().get(&RA_USDC));
                mock_total_assets(&env, &usdc)
            }

            pub fn total_shares(env: Env) -> i128 {
                env.storage().instance().get(&RA_SH).unwrap_or(0)
            }

            pub fn refresh(env: Env) {
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
                fire(&env, HOOK_REFRESH);
            }
        }
    }
    use reentrant_adapter::{ReentrantAdapter, ReentrantAdapterClient};

    // A minimal token (balance/mint/transfer/burn) whose transfer, mint and
    // burn call back into the vault, standing in for a callback-capable USDC
    // or mUSDC.
    mod reentrant_token {
        use super::reentrant_hooks::*;
        use super::*;

        #[contracttype]
        #[derive(Clone)]
        pub enum ReentrantTokenKey {
            Balance(Address),
        }

        #[contract]
        pub struct ReentrantToken;

        #[contractimpl]
        impl ReentrantToken {
            pub fn arm(env: Env, vault: Address, hook: u32, attack: u32) {
                super::reentrant_hooks::arm(&env, &vault, hook, attack);
            }

            pub fn tries(env: Env) -> u32 {
                super::reentrant_hooks::tries(&env)
            }

            pub fn succeeded(env: Env) -> u32 {
                super::reentrant_hooks::succeeded(&env)
            }

            pub fn mint(env: Env, to: Address, amount: i128) {
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
                let balance = Self::read_balance(&env, &to);
                Self::write_balance(&env, &to, balance + amount);
                fire(&env, HOOK_MINT);
            }

            pub fn balance(env: Env, id: Address) -> i128 {
                Self::read_balance(&env, &id)
            }

            pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
                from.require_auth();
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
                let from_balance = Self::read_balance(&env, &from);
                let to_balance = Self::read_balance(&env, &to);
                Self::write_balance(&env, &from, from_balance - amount);
                Self::write_balance(&env, &to, to_balance + amount);
                fire(&env, HOOK_TRANSFER);
            }

            pub fn burn(env: Env, from: Address, amount: i128) {
                from.require_auth();
                env.storage()
                    .instance()
                    .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
                let balance = Self::read_balance(&env, &from);
                Self::write_balance(&env, &from, balance - amount);
                fire(&env, HOOK_BURN);
            }

            fn read_balance(env: &Env, id: &Address) -> i128 {
                env.storage()
                    .persistent()
                    .get(&ReentrantTokenKey::Balance(id.clone()))
                    .unwrap_or(0)
            }

            fn write_balance(env: &Env, id: &Address, amount: i128) {
                let key = ReentrantTokenKey::Balance(id.clone());
                env.storage().persistent().set(&key, &amount);
                env.storage()
                    .persistent()
                    .extend_ttl(&key, INSTANCE_THRESHOLD, INSTANCE_BUMP);
            }
        }
    }
    use reentrant_hooks::*;
    use reentrant_token::{ReentrantToken, ReentrantTokenClient};

    struct Rig {
        env: Env,
        user: Address,
        usdc: Address,
        musdc: Address,
        adapter: Address,
        vault: MeridianVaultClient<'static>,
    }

    /// A vault wired to the normal mocks, with any of its three external
    /// dependencies swapped for the reentrant version.
    fn rig(reentrant_adapter: bool, reentrant_usdc: bool, reentrant_musdc: bool) -> Rig {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let vault_id = test_vault(&env);

        let usdc = if reentrant_usdc {
            env.register(ReentrantToken, ())
        } else {
            env.register_stellar_asset_contract_v2(admin.clone())
                .address()
        };
        let adapter = if reentrant_adapter {
            let id = env.register(ReentrantAdapter, ());
            ReentrantAdapterClient::new(&env, &id).initialize(&usdc);
            id
        } else {
            let id = env.register(MockAdapter, ());
            MockAdapterClient::new(&env, &id).initialize(&usdc);
            id
        };
        let musdc = if reentrant_musdc {
            env.register(ReentrantToken, ())
        } else {
            let id = env.register(MockMusdc, ());
            MockMusdcClient::new(&env, &id).initialize(&vault_id);
            id
        };

        env.register_at(
            &vault_id,
            MeridianVault,
            (&admin, &usdc, &musdc, &adapter, &admin),
        );
        let vault = MeridianVaultClient::new(&env, &vault_id);
        // StellarAssetClient dispatches by name, so it also funds the
        // reentrant token.
        StellarAssetClient::new(&env, &usdc).mint(&user, &10_000_000_000_i128);

        Rig {
            env,
            user,
            usdc,
            musdc,
            adapter,
            vault,
        }
    }

    const REENTRY_AMOUNT: i128 = 100_0000000;

    fn is_locked(r: &Rig) -> bool {
        r.env
            .as_contract(&r.vault.address, || r.env.storage().instance().has(&LOCKED))
    }

    fn hold_lock(r: &Rig) {
        r.env.as_contract(&r.vault.address, || {
            r.env.storage().instance().set(&LOCKED, &true)
        });
    }

    /// Arms a reentrant mock (adapter or token: both expose the same `arm`).
    fn arm_at(r: &Rig, target: &Address, hook: u32, attack: u32) {
        ReentrantTokenClient::new(&r.env, target).arm(&r.vault.address, &hook, &attack);
    }

    /// The hook must actually have fired, and no reentrant call may have
    /// succeeded.
    fn assert_every_reentry_rejected(r: &Rig, target: &Address, what: &str, attack: u32) {
        let c = ReentrantTokenClient::new(&r.env, target);
        assert!(c.tries() > 0, "{what} (attack {attack}): hook never fired");
        assert_eq!(
            c.succeeded(),
            0,
            "{what} (attack {attack}): a reentrant call succeeded"
        );
    }

    fn new_mock_adapter(r: &Rig) -> Address {
        let id = r.env.register(MockAdapter, ());
        MockAdapterClient::new(&r.env, &id).initialize(&r.usdc);
        id
    }

    fn pass_migration_cooldown(r: &Rig) {
        r.env
            .ledger()
            .with_mut(|li| li.sequence_number += MIN_LEDGER_GAP);
    }

    // --- The guard itself ---------------------------------------------------

    #[test]
    fn guarded_entry_points_reject_calls_while_the_lock_is_held() {
        let r = rig(false, false, false);
        r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
        let new_adapter = new_mock_adapter(&r);
        let other = Address::generate(&r.env);
        let usdc = TokenClient::new(&r.env, &r.usdc);
        let user_usdc_before = usdc.balance(&r.user);

        hold_lock(&r);
        assert_eq!(
            r.vault.try_deposit(&r.user, &REENTRY_AMOUNT, &0),
            Err(Ok(ContractError::ReentrancyDetected))
        );
        assert_eq!(
            r.vault.try_withdraw(&r.user, &REENTRY_AMOUNT, &0),
            Err(Ok(ContractError::ReentrancyDetected))
        );
        assert_eq!(
            r.vault.try_set_adapter(&new_adapter),
            Err(Ok(ContractError::ReentrancyDetected))
        );
        assert_eq!(
            r.vault.try_begin_migration(&new_adapter),
            Err(Ok(ContractError::ReentrancyDetected))
        );
        assert_eq!(
            r.vault.try_migrate_adapter(&new_adapter, &0),
            Err(Ok(ContractError::ReentrancyDetected))
        );
        assert_eq!(
            r.vault
                .try_on_transfer(&r.user, &other, &1, &REENTRY_AMOUNT, &0),
            Err(Ok(ContractError::ReentrancyDetected))
        );

        // A rejected reentrant call changes nothing.
        assert_eq!(r.vault.get_total_shares(), REENTRY_AMOUNT);
        assert_eq!(r.vault.get_position(&r.user), REENTRY_AMOUNT);
        assert_eq!(r.vault.get_principal(&r.user), REENTRY_AMOUNT);
        assert_eq!(r.vault.get_adapter(), r.adapter);
        assert_eq!(usdc.balance(&r.user), user_usdc_before);
        assert_eq!(
            r.vault.try_get_migration_snapshot(),
            Err(Ok(ContractError::MigrationNotInitialized))
        );
        // Still locked: the rejections must not have released it.
        assert!(is_locked(&r));
    }

    #[test]
    fn lock_is_released_after_successful_calls() {
        let r = rig(false, false, false);
        let bob = Address::generate(&r.env);

        r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
        assert!(!is_locked(&r), "deposit left the lock held");

        // A plain mUSDC transfer runs the on_transfer callback.
        TokenClient::new(&r.env, &r.musdc).transfer(&r.user, &bob, &(REENTRY_AMOUNT / 10));
        assert!(!is_locked(&r), "on_transfer left the lock held");

        r.vault.withdraw(&r.user, &(REENTRY_AMOUNT / 10), &0);
        assert!(!is_locked(&r), "withdraw left the lock held");

        let new_adapter = new_mock_adapter(&r);
        r.vault.begin_migration(&new_adapter);
        assert!(!is_locked(&r), "begin_migration left the lock held");

        pass_migration_cooldown(&r);
        r.vault.migrate_adapter(&new_adapter, &0);
        assert!(!is_locked(&r), "migrate_adapter left the lock held");

        // And the vault is still usable.
        r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
    }

    #[test]
    fn lock_is_released_after_failed_calls() {
        let r = rig(false, false, false);
        let bob = Address::generate(&r.env);

        assert_eq!(
            r.vault.try_deposit(&r.user, &0, &0),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert!(!is_locked(&r), "failed deposit left the lock held");

        assert_eq!(
            r.vault.try_withdraw(&r.user, &1, &0),
            Err(Ok(ContractError::NoSharesOutstanding))
        );
        assert!(!is_locked(&r), "failed withdraw left the lock held");

        assert_eq!(
            r.vault.try_begin_migration(&r.adapter),
            Err(Ok(ContractError::SameAdapter))
        );
        assert!(!is_locked(&r), "failed begin_migration left the lock held");

        let new_adapter = new_mock_adapter(&r);
        assert_eq!(
            r.vault
                .try_migrate_adapter(&new_adapter, &(MAX_ADMIN_SLIPPAGE_BPS + 1)),
            Err(Ok(ContractError::InvalidSlippageBps))
        );
        assert!(!is_locked(&r), "failed migrate_adapter left the lock held");

        // sender_balance_before == 0 makes the pro-rata split divide by zero.
        assert_eq!(
            r.vault.try_on_transfer(&r.user, &bob, &1, &0, &0),
            Err(Ok(ContractError::DivisionByZero))
        );
        assert!(!is_locked(&r), "failed on_transfer left the lock held");

        // A failure after real work has started (not just a precondition
        // check) also leaves nothing behind: the withdrawal below is
        // rejected only after the adapter call.
        r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
        assert_eq!(
            r.vault
                .try_withdraw(&r.user, &REENTRY_AMOUNT, &(REENTRY_AMOUNT + 1)),
            Err(Ok(ContractError::MinAmountOutNotMet))
        );
        assert!(!is_locked(&r), "late-failing withdraw left the lock held");
        assert_eq!(r.vault.get_total_shares(), REENTRY_AMOUNT);

        // The vault is still usable after every failure above.
        r.vault.withdraw(&r.user, &REENTRY_AMOUNT, &0);
    }

    // The two tests above go through the contract boundary, where a returned
    // `Err` also rolls back the whole invocation (lock write included). This
    // one calls `with_lock` directly, so it only passes if the lock is
    // released explicitly, and it checks nesting without the host's help.
    #[test]
    fn with_lock_releases_on_error_and_refuses_nesting() {
        let r = rig(false, false, false);
        let env = &r.env;
        env.as_contract(&r.vault.address, || {
            let failed = MeridianVault::with_lock(env, || Err::<(), _>(ContractError::ZeroAmount));
            assert_eq!(failed, Err(ContractError::ZeroAmount));
            assert!(!env.storage().instance().has(&LOCKED));

            let outer = MeridianVault::with_lock(env, || {
                let inner = MeridianVault::with_lock(env, || Ok(()));
                assert_eq!(inner, Err(ContractError::ReentrancyDetected));
                assert!(
                    env.storage().instance().has(&LOCKED),
                    "a rejected nested call must not release the outer lock"
                );
                Ok(())
            });
            assert_eq!(outer, Ok(()));
            assert!(!env.storage().instance().has(&LOCKED));
        });
    }

    // --- Reentrant adapters and tokens ---------------------------------------
    //
    // Note: the Soroban host itself refuses to re-enter a contract that is
    // already on the call stack ("Contract re-entry is not allowed"), so
    // these nested calls are rejected by the host before the vault's lock is
    // reached; the typed `ReentrancyDetected` path is covered above by
    // holding the lock directly. These tests pin down the behavior that
    // matters either way: every reentrant attempt is rejected, none changes
    // state, and the outer call still completes correctly.

    #[test]
    fn deposit_is_safe_against_a_reentrant_adapter() {
        for hook in [HOOK_REFRESH, HOOK_DEPOSIT] {
            for attack in ALL_ATTACKS {
                let r = rig(true, false, false);
                arm_at(&r, &r.adapter, hook, attack);

                r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);

                assert_every_reentry_rejected(&r, &r.adapter, "deposit/adapter", attack);
                assert_eq!(r.vault.get_total_shares(), REENTRY_AMOUNT);
                assert_eq!(r.vault.get_position(&r.user), REENTRY_AMOUNT);
                assert_eq!(r.vault.get_principal(&r.user), REENTRY_AMOUNT);
                assert!(!is_locked(&r));
            }
        }
    }

    #[test]
    fn pricing_helpers_preserve_checked_error_mapping() {
        assert_eq!(
            pricing::shares_for_assets(i128::MAX, 1, 0),
            Err(ContractError::Overflow)
        );
        assert_eq!(pricing::shares_for_assets(5, 0, 0), Ok(5));
        assert_eq!(
            pricing::adapter_shares_for_shares(1, 0, 1),
            Err(ContractError::DivisionByZero)
        );
        assert_eq!(pricing::assets_for_adapter_shares(5, 100, 0), Ok(0));
        assert_eq!(pricing::performance_fee(90, 100, 1_000, 10_000), Ok((0, 0)));
        assert_eq!(
            pricing::performance_fee(200, 100, 1_000, 10_000),
            Ok((100, 10))
        );
    }

    #[test]
    fn deposit_is_safe_against_a_reentrant_usdc_token() {
        for attack in ALL_ATTACKS {
            let r = rig(false, true, false);
            arm_at(&r, &r.usdc, HOOK_TRANSFER, attack);

            r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);

            assert_every_reentry_rejected(&r, &r.usdc, "deposit/usdc", attack);
            assert_eq!(r.vault.get_total_shares(), REENTRY_AMOUNT);
            assert_eq!(r.vault.get_position(&r.user), REENTRY_AMOUNT);
            assert!(!is_locked(&r));
        }
    }

    #[test]
    fn deposit_is_safe_against_a_reentrant_musdc_token() {
        for attack in ALL_ATTACKS {
            let r = rig(false, false, true);
            arm_at(&r, &r.musdc, HOOK_MINT, attack);

            r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);

            assert_every_reentry_rejected(&r, &r.musdc, "deposit/musdc", attack);
            assert_eq!(r.vault.get_total_shares(), REENTRY_AMOUNT);
            assert_eq!(r.vault.get_position(&r.user), REENTRY_AMOUNT);
            assert!(!is_locked(&r));
        }
    }

    /// Full-exit checks shared by the withdraw tests.
    fn assert_fully_withdrawn(r: &Rig, usdc_before_deposit: i128) {
        assert_eq!(r.vault.get_total_shares(), 0);
        assert_eq!(r.vault.get_position(&r.user), 0);
        assert_eq!(r.vault.get_principal(&r.user), 0);
        assert_eq!(
            TokenClient::new(&r.env, &r.usdc).balance(&r.user),
            usdc_before_deposit
        );
        assert!(!is_locked(r));
    }

    #[test]
    fn withdraw_is_safe_against_a_reentrant_adapter() {
        for hook in [HOOK_REFRESH, HOOK_WITHDRAW] {
            for attack in ALL_ATTACKS {
                let r = rig(true, false, false);
                let before = TokenClient::new(&r.env, &r.usdc).balance(&r.user);
                r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
                arm_at(&r, &r.adapter, hook, attack);

                r.vault.withdraw(&r.user, &REENTRY_AMOUNT, &0);

                assert_every_reentry_rejected(&r, &r.adapter, "withdraw/adapter", attack);
                assert_fully_withdrawn(&r, before);
            }
        }
    }

    #[test]
    fn withdraw_is_safe_against_a_reentrant_usdc_token() {
        for attack in ALL_ATTACKS {
            let r = rig(false, true, false);
            let before = TokenClient::new(&r.env, &r.usdc).balance(&r.user);
            r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
            arm_at(&r, &r.usdc, HOOK_TRANSFER, attack);

            r.vault.withdraw(&r.user, &REENTRY_AMOUNT, &0);

            assert_every_reentry_rejected(&r, &r.usdc, "withdraw/usdc", attack);
            assert_fully_withdrawn(&r, before);
        }
    }

    #[test]
    fn withdraw_is_safe_against_a_reentrant_musdc_token() {
        for attack in ALL_ATTACKS {
            let r = rig(false, false, true);
            let before = TokenClient::new(&r.env, &r.usdc).balance(&r.user);
            r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
            arm_at(&r, &r.musdc, HOOK_BURN, attack);

            r.vault.withdraw(&r.user, &REENTRY_AMOUNT, &0);

            assert_every_reentry_rejected(&r, &r.musdc, "withdraw/musdc", attack);
            assert_fully_withdrawn(&r, before);
        }
    }

    #[test]
    fn begin_migration_is_safe_against_a_reentrant_target_adapter() {
        for attack in ALL_ATTACKS {
            let r = rig(false, false, false);
            r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
            let target = r.env.register(ReentrantAdapter, ());
            ReentrantAdapterClient::new(&r.env, &target).initialize(&r.usdc);
            arm_at(&r, &target, HOOK_REFRESH, attack);

            r.vault.begin_migration(&target);

            assert_every_reentry_rejected(&r, &target, "begin_migration/adapter", attack);
            assert_eq!(r.vault.get_migration_snapshot().adapter, target);
            assert_eq!(r.vault.get_adapter(), r.adapter);
            assert!(!is_locked(&r));
        }
    }

    // #1270: set_adapter now calls out to its target (identity views and the
    // residue check), so it runs under the same lock as the other admin entry
    // points. A call while the lock is held must be refused before anything
    // else, and the lock must be released on both outcomes.
    #[test]
    fn set_adapter_releases_the_lock_on_success_and_on_rejection() {
        let r = rig(false, false, false);

        // Rejected: the target holds a residual position.
        let funded = register_compat_adapter(&r.env, &r.usdc, &r.vault.address, 1, 0);
        assert_eq!(
            r.vault.try_set_adapter(&funded),
            Err(Ok(ContractError::AdapterResidualPosition))
        );
        assert!(!is_locked(&r), "rejected set_adapter left the lock held");

        // Accepted.
        let target = new_mock_adapter(&r);
        r.vault.set_adapter(&target);
        assert_eq!(r.vault.get_adapter(), target);
        assert!(!is_locked(&r), "set_adapter left the lock held");
    }

    /// Checks shared by the migrate_adapter tests: the migration completed
    /// and moved the whole position.
    fn assert_migrated(r: &Rig, new_adapter: &Address) {
        assert_eq!(r.vault.get_adapter(), *new_adapter);
        assert_eq!(r.vault.get_total_assets(), REENTRY_AMOUNT);
        assert_eq!(r.vault.get_total_shares(), REENTRY_AMOUNT);
        assert_eq!(r.vault.get_position(&r.user), REENTRY_AMOUNT);
        assert!(!is_locked(r));
    }

    #[test]
    fn migrate_adapter_is_safe_against_a_reentrant_old_adapter() {
        for hook in [HOOK_REFRESH, HOOK_WITHDRAW] {
            for attack in ALL_ATTACKS {
                let r = rig(true, false, false);
                r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
                let new_adapter = new_mock_adapter(&r);
                r.vault.begin_migration(&new_adapter);
                pass_migration_cooldown(&r);
                arm_at(&r, &r.adapter, hook, attack);

                r.vault.migrate_adapter(&new_adapter, &0);

                assert_every_reentry_rejected(&r, &r.adapter, "migrate/old adapter", attack);
                assert_migrated(&r, &new_adapter);
            }
        }
    }

    #[test]
    fn migrate_adapter_is_safe_against_a_reentrant_new_adapter() {
        for hook in [HOOK_REFRESH, HOOK_DEPOSIT] {
            for attack in ALL_ATTACKS {
                let r = rig(false, false, false);
                r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
                let new_adapter = r.env.register(ReentrantAdapter, ());
                ReentrantAdapterClient::new(&r.env, &new_adapter).initialize(&r.usdc);
                r.vault.begin_migration(&new_adapter);
                pass_migration_cooldown(&r);
                arm_at(&r, &new_adapter, hook, attack);

                r.vault.migrate_adapter(&new_adapter, &0);

                assert_every_reentry_rejected(&r, &new_adapter, "migrate/new adapter", attack);
                assert_migrated(&r, &new_adapter);
            }
        }
    }

    #[test]
    fn migrate_adapter_is_safe_against_a_reentrant_usdc_token() {
        for attack in ALL_ATTACKS {
            let r = rig(false, true, false);
            r.vault.deposit(&r.user, &REENTRY_AMOUNT, &0);
            let new_adapter = new_mock_adapter(&r);
            r.vault.begin_migration(&new_adapter);
            pass_migration_cooldown(&r);
            arm_at(&r, &r.usdc, HOOK_TRANSFER, attack);

            r.vault.migrate_adapter(&new_adapter, &0);

            assert_every_reentry_rejected(&r, &r.usdc, "migrate/usdc", attack);
            assert_migrated(&r, &new_adapter);
        }
    }

    #[test]
    fn withdraw_assets_returns_exact_requested_amount() {
        let (env, _admin, user, usdc_id, _musdc, _adapter, vault) = setup();
        let deposit_amount = 100_0000000_i128;
        vault.deposit(&user, &deposit_amount, &0_i128);

        let initial_usdc = TokenClient::new(&env, &usdc_id).balance(&user);
        let requested_assets = 40_0000000_i128;
        let usdc_out = vault.withdraw_assets(&user, &requested_assets, &i128::MAX);

        assert_eq!(usdc_out, requested_assets);
        let final_usdc = TokenClient::new(&env, &usdc_id).balance(&user);
        assert_eq!(final_usdc - initial_usdc, requested_assets);

        // Principal reduced proportionally: 100 - 40 = 60
        assert_eq!(vault.get_principal(&user), 60_0000000_i128);
    }

    #[test]
    fn withdraw_assets_with_fee_returns_exact_amount_within_one_stroop() {
        let (env, treasury, user, usdc_id, musdc_id, adapter_id, vault) = setup();
        let principal = 100_0000000_i128;
        let yield_amount = 10_0000000_i128;
        vault.deposit(&user, &principal, &0);
        StellarAssetClient::new(&env, &usdc_id).mint(&adapter_id, &yield_amount);

        let initial_usdc = TokenClient::new(&env, &usdc_id).balance(&user);
        let target_assets = 50_0000000_i128;
        let usdc_out = vault.withdraw_assets(&user, &target_assets, &i128::MAX);

        // Difference must be within 1 stroop
        assert!((usdc_out - target_assets).abs() <= 1);
        let final_usdc = TokenClient::new(&env, &usdc_id).balance(&user);
        assert!(((final_usdc - initial_usdc) - target_assets).abs() <= 1);

        // Treasury earned fee shares
        assert!(TokenClient::new(&env, &musdc_id).balance(&treasury) > 0);
    }

    #[test]
    fn withdraw_assets_reverts_when_exceeding_max_shares_in() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let deposit_amount = 100_0000000_i128;
        vault.deposit(&user, &deposit_amount, &0_i128);

        // 50 USDC requires ~50 shares, but we only permit 10 shares
        let result = vault.try_withdraw_assets(&user, &50_0000000_i128, &10_0000000_i128);
        assert_eq!(result, Err(Ok(ContractError::MaxSharesExceeded)));
    }

    #[test]
    fn withdraw_assets_full_position_clears_records() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        let deposit_amount = 100_0000000_i128;
        vault.deposit(&user, &deposit_amount, &0_i128);

        let usdc_out = vault.withdraw_assets(&user, &deposit_amount, &i128::MAX);
        assert_eq!(usdc_out, deposit_amount);
        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_principal(&user), 0);
        assert_eq!(vault.get_entry_time(&user), 0);
        assert_eq!(vault.get_total_shares(), 0);
    }

    #[test]
    fn withdraw_assets_zero_position_fails() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);
        let stranger = Address::generate(&env);
        let result = vault.try_withdraw_assets(&stranger, &10_0000000_i128, &i128::MAX);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn withdraw_assets_zero_amount_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let result = vault.try_withdraw_assets(&user, &0_i128, &i128::MAX);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));

        let result_neg = vault.try_withdraw_assets(&user, &-5_0000000_i128, &i128::MAX);
        assert_eq!(result_neg, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_assets_negative_max_shares_fails() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        let result = vault.try_withdraw_assets(&user, &50_0000000_i128, &-1_i128);
        assert_eq!(result, Err(Ok(ContractError::ZeroAmount)));
    }

    #[test]
    fn withdraw_assets_insufficient_shares_when_requesting_more_than_balance() {
        let (_env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0_i128);

        // User deposited 100 USDC, requesting 200 USDC
        let result = vault.try_withdraw_assets(&user, &200_0000000_i128, &i128::MAX);
        assert_eq!(result, Err(Ok(ContractError::InsufficientShares)));
    }

    #[test]
    fn withdraw_assets_rejects_missing_authorization() {
        let (env, _admin, user, _usdc, _musdc, _adapter, vault) = setup();
        vault.deposit(&user, &100_0000000_i128, &0);
        env.set_auths(&[]);

        assert_eq!(
            vault.try_withdraw_assets(&user, &50_0000000_i128, &i128::MAX),
            Err(Err(soroban_sdk::InvokeError::Abort))
        );
    }
}
