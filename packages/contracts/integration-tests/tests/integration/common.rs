//! Shared fixture: the real vault, real mUSDC, real Blend adapter and a
//! controllable mock Blend pool, wired together exactly as in production.

use meridian_blend_adapter::{
    MeridianBlendAdapter, MeridianBlendAdapterClient, Positions, Request, Reserve, ReserveConfig,
    ReserveData, RATE_SCALAR, REQUEST_SUPPLY_COLLATERAL, REQUEST_WITHDRAW_COLLATERAL,
};
use meridian_musdc_token::{MusdcToken, MusdcTokenClient};
use meridian_vault::{MeridianVault, MeridianVaultClient};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, Map, String, Symbol, Val, Vec,
};

/// One USDC in stroops (7 decimals).
pub const USDC_UNIT: i128 = 10_000_000;

pub const fn usdc(n: i128) -> i128 {
    n * USDC_UNIT
}

/// Ledger time every fixture starts at.
pub const START_TIME: u64 = 1_000_000;

// ---------------------------------------------------------------------------
// MockBlendPool
// ---------------------------------------------------------------------------

const M_RATE: Symbol = symbol_short!("M_RATE");
const M_COLLAT: Symbol = symbol_short!("M_COLLAT");

/// The adapter's reserve index in the mock pool.
pub const RESERVE_INDEX: u32 = 0;

/// A controllable stand-in for a Blend pool.
///
/// It mirrors the real pool's call shape: `submit` pulls USDC from `from` with
/// a real `token.transfer(from, pool, amount)` (which needs `from`'s
/// authorization, so the adapter's `authorize_as_current_contract` pre-auth is
/// genuinely exercised), and pays withdrawals out of its own USDC balance.
/// Yield is simulated by raising the bToken rate with `set_rate`; the test must
/// also fund the pool with the matching USDC, see `Fixture::simulate_yield`.
#[contract]
pub struct MockBlendPool;

#[contractimpl]
impl MockBlendPool {
    pub fn initialize(env: Env) {
        env.storage().instance().set(&M_RATE, &RATE_SCALAR);
        env.storage().instance().set(&M_COLLAT, &0_i128);
    }

    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&M_RATE, &rate);
    }

    pub fn rate(env: Env) -> i128 {
        env.storage().instance().get(&M_RATE).unwrap()
    }

    /// Total bTokens held as collateral.
    pub fn collateral(env: Env) -> i128 {
        env.storage().instance().get(&M_COLLAT).unwrap_or(0)
    }

    pub fn submit(
        env: Env,
        from: Address,
        _spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Val {
        let rate: i128 = env.storage().instance().get(&M_RATE).unwrap();
        let mut collateral: i128 = env.storage().instance().get(&M_COLLAT).unwrap_or(0);

        for req in requests.iter() {
            if req.request_type == REQUEST_SUPPLY_COLLATERAL {
                TokenClient::new(&env, &req.address).transfer(
                    &from,
                    &env.current_contract_address(),
                    &req.amount,
                );
                collateral += req.amount * RATE_SCALAR / rate;
            } else if req.request_type == REQUEST_WITHDRAW_COLLATERAL {
                collateral -= req.amount * RATE_SCALAR / rate;
                TokenClient::new(&env, &req.address).transfer(
                    &env.current_contract_address(),
                    &to,
                    &req.amount,
                );
            }
        }
        env.storage().instance().set(&M_COLLAT, &collateral);
        Val::VOID.into()
    }

    pub fn get_reserve(env: Env, asset: Address) -> Reserve {
        let rate: i128 = env.storage().instance().get(&M_RATE).unwrap();
        Reserve {
            asset,
            config: ReserveConfig {
                index: RESERVE_INDEX,
                decimals: 7,
                c_factor: 0,
                l_factor: 0,
                util: 0,
                max_util: 0,
                r_base: 0,
                r_one: 0,
                r_two: 0,
                r_three: 0,
                reactivity: 0,
                supply_cap: 0,
                enabled: true,
            },
            data: ReserveData {
                d_rate: rate,
                b_rate: rate,
                ir_mod: 0,
                b_supply: 0,
                d_supply: 0,
                backstop_credit: 0,
                last_time: 0,
            },
            // Deliberately NOT RATE_SCALAR: the real reserve reports
            // 10^decimals here, and the adapter must ignore it.
            scalar: USDC_UNIT,
        }
    }

    pub fn get_positions(env: Env, _address: Address) -> Positions {
        let collateral: i128 = env.storage().instance().get(&M_COLLAT).unwrap_or(0);
        let mut collateral_map = Map::new(&env);
        collateral_map.set(RESERVE_INDEX, collateral);
        Positions {
            liabilities: Map::new(&env),
            collateral: collateral_map,
            supply: Map::new(&env),
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A pool plus the real adapter wired to it.
pub struct Venue {
    pub pool: MockBlendPoolClient<'static>,
    pub adapter: MeridianBlendAdapterClient<'static>,
}

pub struct Fixture {
    pub env: Env,
    /// Vault admin.
    pub admin: Address,
    /// Performance-fee treasury (receives fee mUSDC).
    pub treasury: Address,
    /// USDC issuer / SAC admin.
    pub usdc_issuer: Address,
    pub usdc: Address,
    /// The primary venue (the vault's initial adapter and its pool).
    pub venue: Venue,
    pub musdc: Address,
    pub vault: MeridianVaultClient<'static>,
}

impl Fixture {
    /// Registers and wires the full system, then switches the environment to
    /// enforcing authorization: nothing after `new()` is implicitly authorized.
    pub fn new() -> Self {
        let env = Env::default();
        // Registration needs the vault admin's constructor auth; mocked only
        // for setup and replaced by `set_auths(&[])` below.
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = START_TIME;
            li.sequence_number = 1_000;
            // The migration timelock advances the ledger by a day's worth of
            // sequences; keep every entry alive across it.
            li.min_persistent_entry_ttl = 1_000_000;
            li.min_temp_entry_ttl = 1_000_000;
        });

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc_issuer = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(usdc_issuer.clone())
            .address();

        // vault <-> mUSDC <-> adapter reference one another, so fix the
        // vault's and mUSDC's addresses before registering any of them.
        let vault_id = Address::generate(&env);
        let musdc_id = Address::generate(&env);

        let venue = Self::register_venue(&env, &vault_id, &usdc);

        env.register_at(
            &musdc_id,
            MusdcToken,
            (
                vault_id.clone(),
                7_u32,
                String::from_str(&env, "Meridian USDC"),
                String::from_str(&env, "mUSDC"),
            ),
        );
        env.register_at(
            &vault_id,
            MeridianVault,
            (
                admin.clone(),
                usdc.clone(),
                musdc_id.clone(),
                venue.adapter.address.clone(),
                treasury.clone(),
            ),
        );

        // Enforcing mode from here on.
        env.set_auths(&[]);

        Self {
            vault: MeridianVaultClient::new(&env, &vault_id),
            env,
            admin,
            treasury,
            usdc_issuer,
            usdc,
            venue,
            musdc: musdc_id,
        }
    }

    /// Registers a fresh mock pool and a real adapter pointing at it.
    pub fn register_venue(env: &Env, vault: &Address, usdc: &Address) -> Venue {
        let pool_id = env.register(MockBlendPool, ());
        let pool = MockBlendPoolClient::new(env, &pool_id);
        pool.initialize();
        let adapter_id = env.register(
            MeridianBlendAdapter,
            (vault.clone(), pool_id.clone(), usdc.clone()),
        );
        Venue {
            pool,
            adapter: MeridianBlendAdapterClient::new(env, &adapter_id),
        }
    }

    /// A second venue for migration tests, wired to this fixture's vault.
    pub fn new_venue(&self) -> Venue {
        Self::register_venue(&self.env, &self.vault.address, &self.usdc)
    }

    // -- clients ------------------------------------------------------------

    pub fn usdc_client(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.usdc)
    }

    pub fn musdc_token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.musdc)
    }

    pub fn musdc_admin(&self) -> MusdcTokenClient<'_> {
        MusdcTokenClient::new(&self.env, &self.musdc)
    }

    pub fn usdc_balance(&self, who: &Address) -> i128 {
        self.usdc_client().balance(who)
    }

    pub fn musdc_balance(&self, who: &Address) -> i128 {
        self.musdc_token().balance(who)
    }

    // -- authorization ------------------------------------------------------

    /// Authorizes exactly one root invocation by `who`, with the given
    /// authorized sub-invocations. Anything else a call needs to authorize
    /// is rejected by the host.
    pub fn authorize(
        &self,
        who: &Address,
        contract: &Address,
        fn_name: &str,
        args: impl IntoVal<Env, Vec<Val>>,
        sub_invokes: &[MockAuthInvoke],
    ) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract,
                fn_name,
                args: args.into_val(&self.env),
                sub_invokes,
            },
        }]);
    }

    /// Authorizes a root `vault.<fn_name>(args)` call by the vault admin.
    pub fn authorize_admin(&self, fn_name: &str, args: impl IntoVal<Env, Vec<Val>>) {
        self.authorize(&self.admin, &self.vault.address, fn_name, args, &[]);
    }

    // -- time ---------------------------------------------------------------

    pub fn set_time(&self, timestamp: u64) {
        self.env.ledger().with_mut(|li| li.timestamp = timestamp);
    }

    pub fn advance_ledgers(&self, n: u32) {
        self.env.ledger().with_mut(|li| li.sequence_number += n);
    }

    // -- user flows (each carries the real authorization tree) --------------

    /// Mints `amount` USDC to `who` (as the USDC issuer would).
    pub fn fund(&self, who: &Address, amount: i128) {
        self.authorize(
            &self.usdc_issuer,
            &self.usdc,
            "mint",
            (who.clone(), amount),
            &[],
        );
        StellarAssetClient::new(&self.env, &self.usdc).mint(who, &amount);
    }

    /// `vault.deposit(user, amount, 0)`. The user authorizes the deposit and,
    /// beneath it, the vault's USDC pull into the adapter.
    pub fn deposit(&self, user: &Address, amount: i128) -> i128 {
        self.deposit_into(&self.venue, user, amount)
    }

    /// Like `deposit`, but names the adapter the vault currently routes to
    /// (needed after a migration, since the USDC lands on that adapter).
    pub fn deposit_into(&self, venue: &Venue, user: &Address, amount: i128) -> i128 {
        self.authorize(
            user,
            &self.vault.address,
            "deposit",
            (user.clone(), amount, 0_i128),
            &[MockAuthInvoke {
                contract: &self.usdc,
                fn_name: "transfer",
                args: (user.clone(), venue.adapter.address.clone(), amount).into_val(&self.env),
                sub_invokes: &[],
            }],
        );
        self.vault.deposit(user, &amount, &0_i128)
    }

    /// `vault.withdraw(user, shares, 0)`. The user authorizes the withdrawal
    /// and, beneath it, the mUSDC burn.
    pub fn withdraw(&self, user: &Address, shares: i128) -> i128 {
        self.authorize(
            user,
            &self.vault.address,
            "withdraw",
            (user.clone(), shares, 0_i128),
            &[MockAuthInvoke {
                contract: &self.musdc,
                fn_name: "burn",
                args: (user.clone(), shares).into_val(&self.env),
                sub_invokes: &[],
            }],
        );
        self.vault.withdraw(user, &shares, &0_i128)
    }

    /// `musdc.transfer(from, to, amount)`. Only `from` signs; the callback
    /// into the vault is authorized by mUSDC being the direct caller, with no
    /// signature of its own.
    pub fn transfer(&self, from: &Address, to: &Address, amount: i128) {
        self.authorize(
            from,
            &self.musdc,
            "transfer",
            (from.clone(), to.clone(), amount),
            &[],
        );
        self.musdc_token().transfer(from, to, &amount);
    }

    // -- yield --------------------------------------------------------------

    /// Raises the primary pool's bToken rate to `new_rate` and funds the pool
    /// with the USDC that yield represents, so withdrawals stay solvent. Pass a
    /// rate below the current one to simulate a loss (no funding needed).
    pub fn simulate_yield(&self, new_rate: i128) {
        self.simulate_yield_on(&self.venue, new_rate);
    }

    pub fn simulate_yield_on(&self, venue: &Venue, new_rate: i128) {
        let old_rate = venue.pool.rate();
        let collateral = venue.pool.collateral();
        let extra = collateral * (new_rate - old_rate) / RATE_SCALAR;
        if extra > 0 {
            self.fund(&venue.pool.address, extra);
        }
        venue.pool.set_rate(&new_rate);
    }
}

/// `RATE_SCALAR * (10_000 + bps) / 10_000`: the bToken rate after `bps` of yield.
pub fn rate_with_yield_bps(bps: i128) -> i128 {
    RATE_SCALAR * (10_000 + bps) / 10_000
}
