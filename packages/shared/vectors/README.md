# Vault Math Conformance Vectors

This directory contains versioned JSON vector files (`vault_math_v1.json`) covering ERC-4626 deposit minting, withdrawal payout, virtual offset, performance fees, and edge cases.

## Generation and Versioning

- The vectors are maintained alongside the contract and SDK implementations.
- When the contract pricing logic (`packages/contracts/vault/src/pricing.rs`) or SDK vault base (`packages/sdk/src/vault-base.ts`) changes its math or version, a new vector version file (`vault_math_vN.json`) must be introduced or updated.
- Both Rust and TypeScript test suites load and execute these vectors during CI to prevent drift between implementations.
