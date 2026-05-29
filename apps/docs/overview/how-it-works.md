# How It Works

## Deposit flow

```
User enters amount
       │
       ▼
Frontend POSTs { walletAddress, vaultId, amount }
to POST /api/v1/tx/deposit
       │
       ▼
API fetches account sequence from Soroban RPC
builds invokeHostFunction calling vault.deposit(caller, amount, route_to)
simulates transaction to get resource footprint and fee
returns { xdr, fee }
       │
       ▼
Frontend passes XDR to Freighter
User reviews and approves (sees: contract, function, amount, protocol)
Freighter returns signed XDR
       │
       ▼
Frontend POSTs { xdr } to POST /api/v1/tx/submit
API forwards to Stellar RPC
       │
       ▼
Transaction settles (~5 seconds)
Vault mints mUSDC shares to user's wallet
```

## Withdraw flow

Symmetric to deposit. The user specifies a share amount (mUSDC), the API builds a `vault.withdraw(caller, shares)` invocation, Freighter signs, and the vault burns shares and returns USDC.

## Rate selection

The API reads live APY data from two sources:

- **Blend Capital pools** via DeFiLlama's `/pools` endpoint, filtered to Stellar stablecoins and matched against a curated pool registry.
- **DeFindex vaults** via direct Soroban contract queries on testnet (currently returns estimated figures pending full integration).

The vault with the highest APY becomes `bestVault`. Its ID is passed to the deposit endpoint, which maps it to the `Protocol` enum (`Blend` or `DeFindex`) used by the vault contract.

## Share pricing

The vault uses a proportional share model. When a user deposits:

```
shares_minted = deposit_amount * total_shares / vault_balance
```

If the vault has no outstanding shares, `shares = amount` (1:1 at genesis). As yield accrues and `vault_balance` grows relative to `total_shares`, the share price rises. Withdrawers receive:

```
usdc_out = shares_burned * vault_balance / total_shares
```

This means early depositors automatically benefit from yield without any claim or harvest action.

## Security properties

- **No server-side keys.** The API returns unsigned XDR only. Private keys never leave Freighter.
- **User-visible routing.** The `route_to` parameter is part of the signed transaction. The user sees exactly which protocol their funds are going to before signing.
- **On-chain state.** USDC balances, share balances, and the active protocol are all stored in Soroban contract storage, auditable by anyone.
