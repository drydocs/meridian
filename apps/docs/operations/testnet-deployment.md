# Testnet Deployment

## Prerequisites

- Stellar CLI: `cargo install stellar-cli`
- A funded testnet keypair (see below)
- Rust with the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`

## Generate and fund a testnet keypair

```bash
# Generate a new keypair and store it in the Stellar CLI keystore
stellar keys generate --network testnet deployer

# Print the public key
stellar keys address deployer

# Fund via Friendbot (replace with your public key)
curl "https://friendbot.stellar.org/?addr=$(stellar keys address deployer)"
```

## Build the vault contract

```bash
cd packages/contracts/vault
stellar contract build
```

This produces `target/wasm32-unknown-unknown/release/meridian_vault.wasm`.

## Deploy USDC and mUSDC (testnet only)

On testnet, deploy mock SAC (Stellar Asset Contract) instances for USDC and mUSDC. On mainnet, use the real USDC contract address from `CONTRACT_ADDRESSES.testnet.usdc`.

```bash
# Deploy mock USDC
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/meridian_vault.wasm \
  --network testnet \
  --source deployer
```

Record the returned contract ID as `USDC_CONTRACT_ID`.

Repeat for mUSDC and record as `MUSDC_CONTRACT_ID`.

## Deploy the vault contract

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/meridian_vault.wasm \
  --network testnet \
  --source deployer
```

Record the returned contract ID as `VAULT_CONTRACT_ID`.

## Initialize the vault

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT_ID \
  --network testnet \
  --source deployer \
  -- initialize \
  --admin $(stellar keys address deployer) \
  --usdc $USDC_CONTRACT_ID \
  --musdc $MUSDC_CONTRACT_ID
```

## Transfer mUSDC admin to the vault

The vault must be the admin of the mUSDC asset in order to mint and burn share tokens autonomously.

```bash
stellar contract invoke \
  --id $MUSDC_CONTRACT_ID \
  --network testnet \
  --source deployer \
  -- set_admin \
  --new_admin $VAULT_CONTRACT_ID
```

## Update contract addresses

Add the deployed `VAULT_CONTRACT_ID` to `packages/shared/src/constants.ts`:

```typescript
export const CONTRACT_ADDRESSES = {
  testnet: {
    vault: "C...", // paste VAULT_CONTRACT_ID here
    usdc: "C...",
    musdc: "C...",
    // ...
  },
};
```

## Set the Vercel environment variable

```bash
vercel env add VAULT_CONTRACT_ID
# paste the deployed contract ID when prompted
```

Or set it in the Vercel dashboard under **Project Settings > Environment Variables**.

## Verify the deployment

```bash
# Check total assets (should be 0 after initialization)
stellar contract invoke \
  --id $VAULT_CONTRACT_ID \
  --network testnet \
  --source deployer \
  -- get_total_assets
```

A return value of `0` confirms the contract is initialized and responding.

## Run the signing flow end-to-end

With the contract deployed and `VAULT_CONTRACT_ID` set:

1. Open the app, connect Freighter (testnet mode).
2. Enter a USDC amount and click **Deposit**.
3. Freighter should display the transaction details; verify the contract address matches `VAULT_CONTRACT_ID`.
4. Approve the transaction.
5. After ~5 seconds, the position summary should update with your deposited amount.
