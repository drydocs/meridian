# API Layer

Meridian has two API implementations that share the same interface:

| Implementation | Used in | Location |
|---|---|---|
| Vercel serverless functions | Production | `api/v1/` |
| Fastify server | Local development | `apps/api/` |

## Endpoints

### `GET /api/v1/vaults`

Returns all available vaults with live APY and TVL.

**Response**
```json
{
  "vaults": [
    {
      "id": "blend-usdc-variable",
      "protocol": "blend",
      "asset": "USDC",
      "name": "Blend Capital",
      "label": "Variable Rate",
      "apy": 7.42,
      "tvl": 1240000,
      "userBalance": 0,
      "riskLevel": "safe"
    }
  ],
  "updatedAt": "2026-05-26T12:00:00.000Z",
  "cached": false
}
```

APY data is sourced from DeFiLlama's `/pools` endpoint filtered to Stellar stablecoins. Pools are matched against a curated registry (`known-pools.ts`) that maps DeFiLlama pool UUIDs to protocol metadata.

### `GET /api/v1/vaults/:vaultId`

Returns a single vault or 404.

### `GET /api/v1/positions/:publicKey`

Returns the user's on-chain position.

**Response**
```json
{
  "positions": [
    {
      "vaultId": "blend-usdc-variable",
      "deposited": 100.00,
      "earned": 2.34,
      "entryTime": 1716729600
    }
  ]
}
```

Currently returns an empty array pending on-chain position indexing (issue #6).

### `POST /api/v1/tx/deposit`

Builds an unsigned Soroban deposit transaction.

**Request**
```json
{
  "walletAddress": "G...",
  "vaultId": "blend-usdc-variable",
  "amount": "100.00"
}
```

**Response**
```json
{
  "xdr": "AAAAAgAAAAA...",
  "fee": "12345"
}
```

The `xdr` field is a base64-encoded unsigned `TransactionEnvelope`. The `fee` is the simulated resource fee in stroops. The client must forward the XDR to Freighter for signing before submitting.

### `POST /api/v1/tx/withdraw`

Builds an unsigned Soroban withdraw transaction.

**Request**
```json
{
  "walletAddress": "G...",
  "vaultId": "blend-usdc-variable",
  "shares": "95.5000000"
}
```

**Response:** same shape as deposit: `{ xdr, fee }`.

### `POST /api/v1/tx/submit`

Submits a Freighter-signed XDR to the Stellar network.

**Request**
```json
{ "xdr": "AAAAAgAAAAA..." }
```

**Response**
```json
{ "hash": "abc123..." }
```

A `PENDING` or `DUPLICATE` status from the Stellar RPC is treated as success and the hash is returned. An `ERROR` status returns 500.

## Serverless vs Fastify

The Vercel serverless functions (`api/v1/`) cannot import from workspace packages (`@meridian/shared`, `@meridian/stellar-sdk-helpers`). All logic is inlined in `_shared.ts` files alongside each route group. This constraint was introduced to avoid build-time workspace resolution issues on Vercel.

The Fastify server (`apps/api/`) has no such restriction and imports freely from workspace packages. It is only used during local development.

## Vault ID to protocol mapping

When building a deposit transaction, the `vaultId` is mapped to the `Protocol` enum expected by the vault contract:

| Vault ID prefix | Protocol |
|---|---|
| `blend-` | `Blend` |
| `defindex-` | `DeFindex` |

Any other prefix returns a 500 with a clear mapping error. The Ondo protocol (`ondo-`) is not currently supported by the vault contract.
