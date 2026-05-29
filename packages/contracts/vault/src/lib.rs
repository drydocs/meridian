#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token::{self, TokenClient},
    Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const ADMIN: Symbol = symbol_short!("ADMIN");
const USDC: Symbol = symbol_short!("USDC");
const MUSDC: Symbol = symbol_short!("MUSDC");
const PROTOCOL: Symbol = symbol_short!("PROTOCOL");
const TOTAL_SH: Symbol = symbol_short!("TOTAL_SH");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Protocol {
    Blend,
    DeFindex,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Balance(Address),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct MeridianVault;

#[contractimpl]
impl MeridianVault {
    /// Called once at deployment. Sets the admin, USDC token address, and
    /// mUSDC share token address.
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc: Address,
        musdc: Address,
    ) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&USDC, &usdc);
        env.storage().instance().set(&MUSDC, &musdc);
        env.storage().instance().set(&TOTAL_SH, &0_i128);
    }

    /// Deposit `amount` USDC into the vault.
    ///
    /// `route_to` is determined off-chain by comparing live Blend and DeFindex
    /// rates. The caller (frontend + API) fetches both rates, picks the winner,
    /// and passes it here. The user sees and signs this parameter before the
    /// transaction is submitted.
    ///
    /// Returns the number of mUSDC shares minted to the caller.
    pub fn deposit(env: Env, caller: Address, amount: i128, route_to: Protocol) -> i128 {
        caller.require_auth();
        assert!(amount > 0, "amount must be positive");

        let usdc = Self::usdc(&env);
        let musdc = Self::musdc(&env);
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let vault_balance = TokenClient::new(&env, &usdc)
            .balance(&env.current_contract_address());

        // Share price: if no shares exist yet, 1 share = 1 stroop of USDC.
        // Otherwise maintain the existing share price.
        let shares_to_mint = if total_shares == 0 || vault_balance == 0 {
            amount
        } else {
            // shares_to_mint = amount * total_shares / vault_balance
            amount
                .checked_mul(total_shares)
                .expect("overflow")
                .checked_div(vault_balance)
                .expect("div zero")
        };

        assert!(shares_to_mint > 0, "deposit too small");

        // Pull USDC from caller into the vault.
        TokenClient::new(&env, &usdc).transfer(&caller, &env.current_contract_address(), &amount);

        // Mint mUSDC shares to caller.
        token::StellarAssetClient::new(&env, &musdc).mint(&caller, &shares_to_mint);

        // Record the active protocol.
        env.storage().instance().set(&PROTOCOL, &route_to);

        // Update total shares.
        env.storage()
            .instance()
            .set(&TOTAL_SH, &(total_shares + shares_to_mint));

        // Track per-address share balance.
        let key = DataKey::Balance(caller.clone());
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(prev + shares_to_mint));

        shares_to_mint
    }

    /// Withdraw by burning `shares` mUSDC. Returns the USDC amount sent back
    /// to the caller.
    pub fn withdraw(env: Env, caller: Address, shares: i128) -> i128 {
        caller.require_auth();
        assert!(shares > 0, "shares must be positive");

        let usdc = Self::usdc(&env);
        let musdc = Self::musdc(&env);
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SH).unwrap_or(0);
        let vault_balance = TokenClient::new(&env, &usdc)
            .balance(&env.current_contract_address());

        assert!(total_shares > 0, "no shares outstanding");

        // Verify caller holds enough shares.
        let key = DataKey::Balance(caller.clone());
        let caller_shares: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        assert!(caller_shares >= shares, "insufficient shares");

        // usdc_out = shares * vault_balance / total_shares
        let usdc_out = shares
            .checked_mul(vault_balance)
            .expect("overflow")
            .checked_div(total_shares)
            .expect("div zero");

        assert!(usdc_out > 0, "withdrawal too small");

        // Burn mUSDC from caller (standard token interface).
        TokenClient::new(&env, &musdc).burn(&caller, &shares);

        // Send USDC back to caller.
        TokenClient::new(&env, &usdc).transfer(&env.current_contract_address(), &caller, &usdc_out);

        // Update state.
        env.storage()
            .instance()
            .set(&TOTAL_SH, &(total_shares - shares));
        env.storage()
            .persistent()
            .set(&key, &(caller_shares - shares));

        usdc_out
    }

    /// Returns the caller's mUSDC share balance.
    pub fn get_position(env: Env, address: Address) -> i128 {
        let key = DataKey::Balance(address);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Returns the protocol where funds currently sit.
    pub fn get_active_protocol(env: Env) -> Protocol {
        env.storage()
            .instance()
            .get(&PROTOCOL)
            .unwrap_or(Protocol::Blend)
    }

    /// Returns total USDC held by the vault.
    pub fn get_total_assets(env: Env) -> i128 {
        let usdc = Self::usdc(&env);
        TokenClient::new(&env, &usdc).balance(&env.current_contract_address())
    }

    /// Returns total mUSDC shares outstanding.
    pub fn get_total_shares(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_SH).unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn usdc(env: &Env) -> Address {
        env.storage().instance().get(&USDC).unwrap()
    }

    fn musdc(env: &Env) -> Address {
        env.storage().instance().get(&MUSDC).unwrap()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{StellarAssetClient, TokenClient},
        Address, Env,
    };

    fn setup() -> (Env, Address, Address, Address, Address, MeridianVaultClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy mock USDC and mUSDC tokens.
        let usdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let musdc_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

        // Deploy and initialise the vault.
        let vault_id = env.register(MeridianVault, ());
        let vault = MeridianVaultClient::new(&env, &vault_id);
        vault.initialize(&admin, &usdc_id, &musdc_id);

        // Transfer mUSDC admin to the vault contract so it can mint and burn
        // share tokens autonomously during deposits and withdrawals.
        StellarAssetClient::new(&env, &musdc_id).set_admin(&vault_id);

        // Fund the user with 1000 USDC (7 decimal places: 1000 * 10^7).
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &1_000_0000000_i128);

        (env, admin, user, usdc_id, musdc_id, vault)
    }

    #[test]
    fn deposit_mints_shares() {
        let (_env, _admin, user, _usdc, _musdc, vault) = setup();

        let amount = 100_0000000_i128; // 100 USDC
        let shares = vault.deposit(&user, &amount, &Protocol::Blend);

        assert_eq!(shares, amount);
        assert_eq!(vault.get_position(&user), amount);
        assert_eq!(vault.get_total_shares(), amount);
        assert_eq!(vault.get_active_protocol(), Protocol::Blend);
    }

    #[test]
    fn withdraw_returns_usdc() {
        let (_env, _admin, user, usdc_id, _musdc, vault) = setup();
        let env = _env;

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &Protocol::Blend);

        let shares = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares);

        assert_eq!(usdc_out, amount);
        assert_eq!(vault.get_position(&user), 0);
        assert_eq!(vault.get_total_shares(), 0);

        // User should have their USDC back.
        let user_balance = TokenClient::new(&env, &usdc_id).balance(&user);
        assert_eq!(user_balance, 1_000_0000000_i128);
    }

    #[test]
    fn share_price_reflects_yield() {
        let (_env, _admin, user, usdc_id, _musdc, vault) = setup();
        let env = _env;
        let vault_id = vault.address.clone();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &Protocol::Blend);

        // Simulate yield accrual: send 10 USDC directly to the vault
        // (as if Blend returned principal + interest).
        let yield_amount = 10_0000000_i128;
        StellarAssetClient::new(&env, &usdc_id).mint(&vault_id, &yield_amount);

        // A second user deposits 100 USDC — should receive fewer shares
        // because the share price has risen.
        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &usdc_id).mint(&user2, &1_000_0000000_i128);
        let shares2 = vault.deposit(&user2, &amount, &Protocol::Blend);

        // 100 shares outstanding, vault has 110 USDC.
        // shares2 = 100 * 100 / 110 ≈ 90 shares.
        assert!(shares2 < amount, "second depositor should receive fewer shares");

        // First user withdraws — should get more than 100 USDC back.
        let shares1 = vault.get_position(&user);
        let usdc_out = vault.withdraw(&user, &shares1);
        assert!(usdc_out > amount, "first depositor should profit from yield");
    }

    #[test]
    #[should_panic(expected = "insufficient shares")]
    fn withdraw_more_than_balance_panics() {
        let (_env, _admin, user, _usdc, _musdc, vault) = setup();

        let amount = 100_0000000_i128;
        vault.deposit(&user, &amount, &Protocol::Blend);
        vault.withdraw(&user, &(amount * 2));
    }
}
