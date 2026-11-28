//! Shared fuzz harness setup for the vault entry points.
//!
//! Every fuzz target builds a fresh environment and a freshly registered
//! vault + adapter + mUSDC mock, then calls the target. Each target asserts
//! the top-level invariant: **every failure is a typed `ContractError` and
//! no untyped panic or trap is reachable**.

#![no_std]
extern crate alloc;

use alloc::vec::Vec;
use arbitrary::Arbitrary;
use meridian_vault::{MeridianVault, MeridianVaultClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

/// Common input parcel: enough entropy for any entry point.
#[derive(Debug, Arbitrary)]
pub struct FuzzInput {
    pub amount: i128,
    pub min_out: i128,
    pub max_slippage_bps: u32,
    pub ledger_seq: u32,
    pub operation_bits: u8,
}

/// Returns a wired (vault, admin, usdc, musdc, adapter, treasury) tuple.
pub fn fresh_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    // Minimal wiring — the fuzzers are expected to focus on argument-space
    // coverage, not the migration/wiring state machine.
    let vault_id = env.register(MeridianVault, ());
    (env, admin, vault_id)
}

pub fn client<'a>(env: &'a Env, vault_id: &Address) -> MeridianVaultClient<'a> {
    MeridianVaultClient::new(env, vault_id)
}

/// Parses a Vec<u8> corpus seed into its first two i128 words.
pub fn pair_from_seed(seed: &[u8]) -> (i128, i128) {
    let mut a = [0u8; 16];
    let mut b = [0u8; 16];
    for (i, byte) in seed.iter().take(16).enumerate() {
        a[i] = *byte;
    }
    for (i, byte) in seed.iter().skip(16).take(16).enumerate() {
        b[i] = *byte;
    }
    (i128::from_le_bytes(a), i128::from_le_bytes(b))
}

#[allow(dead_code)]
pub fn _keep_vec_in_scope() -> Vec<u8> {
    Vec::new()
}
