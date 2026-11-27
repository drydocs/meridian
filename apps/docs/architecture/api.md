# API Layer

Meridian has two API implementations that share the same interface:

| Implementation              | Used in           | Location          |
| --------------------------- | ----------------- | ----------------- |
| Vercel serverless functions | Production        | `api/v1/`         |
| Fastify server              | Local development | `apps/api-local/` |

## Request IDs and errors

Every response includes an `X-Request-ID` header. Clients may send a
well-formed value in the same header; otherwise the API generates a UUID. The
ID is included in structured server logs so operators can match a client
failure to its request.

Responses with status `400` or higher use one stable envelope in both API
implementations:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "walletAddress: Invalid input",
    "requestId": "support-2026.11:abc"
  }
}
```

`code` is stable for the HTTP failure class (or an existing explicit code),
`message` is safe for the caller, and `requestId` is the value from the
response header. Resource-specific fields remain alongside the envelope for
backward-compatible access.

The codes, their causes and the recommended client action for each are listed in the [API Error Reference](./api-errors.md).

## Endpoints

The machine-readable OpenAPI specification lives at [`docs/openapi.yaml`](https://github.com/drydocs/meridian/blob/main/docs/openapi.yaml).

### `GET /api/v1/config`

Returns public network, contract, active adapter, supported asset, and feature-flag metadata derived from `@meridian/shared` constants. Never includes secrets, private infrastructure URLs, keeper settings, or admin-only data.

**Response**

```json
{
  "network": "mainnet",
  "passphrase": "Public Global Stellar Network ; September 2015",
  "contracts": {
    "vault": "CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ",
    "usdc": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    "musdc": "CAEJJPN73VOEWUVCXCXMIXOHMFLUXAYVFMCTCJHQFI5R2NIB2S5YTOFL",
    "eurc": "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
    "blendPool": "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    "defindexVault": null,
    "defindexFactory": null
  },
  "activeAdapter": {
    "address": "CBNKERYAG7VZNBH2V3TF5JBXLD3MXLVQW5GG4AO445EUDCPKP4D2DDP2",
    "protocol": "blend"
  },
  "degraded": false,
  "supportedAssets": ["USDC", "EURC"],
  "features": {
    "defindexEnabled": false,
    "musdcTrustlineRequired": false,
    "riskAcknowledgementRequired": true
  }
}
```

Cached briefly with `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300`. If live active adapter resolution fails, `activeAdapter` is returned as `null` with `degraded: true` (distinguishing an RPC failure from a vault with no adapter) and `Cache-Control: no-store` so transient RPC failures are not cached.

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
  "recommendedVaultId": "blend-usdc-variable",
  "updatedAt": "2026-05-26T12:00:00.000Z",
  "cached": false
}
```

APY data is sourced from DeFiLlama's `/pools` endpoint filtered to Stellar stablecoins. Pools are matched against a curated registry (`known-pools.ts`) that maps DeFiLlama pool UUIDs to protocol metadata. `recommendedVaultId` is the vault with the highest APY, or `null` if none qualifies.

### `GET /api/v1/vaults/:vaultId`

Returns a single vault or 404.

### `GET /api/v1/positions/:publicKey`

Returns the user's on-chain position. Results are cached for 15 seconds by
network, wallet, and latest Stellar ledger, with concurrent cold reads for the
same wallet coalesced. Responses include an `ETag` derived from those same
values; send it as `If-None-Match` to receive `304 Not Modified`. Add
`?refresh=true` to bypass the position cache and force a fresh contract read.
The response remains `Cache-Control: no-store`; this conditional request
support is for clients rather than intermediary caching.

**Response**

```json
{
  "positions": [
    {
      "vaultId": "blend-usdc-variable",
      "shares": 100.0,
      "deposited": 100.0,
      "earned": 2.34,
      "entryTime": 1716729600
    }
  ]
}
```

Reads position data directly from the vault contract via `simulateTransaction`. Returns an empty array if the wallet holds no shares.

### `GET /api/v1/positions/:publicKey/history`

Returns the stored position-value time series for a wallet, oldest first ([#973](https://github.com/drydocs/meridian/issues/973)). Soroban retains no queryable historical state, so history exists only from the moment snapshots started being captured.

**Query:** `days` (optional positive integer, default `30`, capped at the `90`-day retention window). Anything else returns `400`.

Three optional parameters switch the endpoint to bucketed, paginated responses. A request that sends none of them gets the response shown below with every stored snapshot, oldest first.

| Parameter    | Values                               | Meaning                                                                                                                               |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `resolution` | `hour` (default) or `day`            | Bucket size in UTC. Each bucket reports the latest `totalValue`, `totalEarned` and `vaults`, plus the `min` and `max` of both totals. |
| `limit`      | integer `1` to `1000`, default `720` | Maximum number of buckets in one page.                                                                                                |
| `cursor`     | timestamp in milliseconds            | Return only buckets after this timestamp. Use the `nextCursor` from the previous page.                                                |

A paginated response adds `resolution`, `nextCursor` (the timestamp of the last bucket in the page, or `null` when there is nothing more) and `truncated` (`true` when more buckets remain). An invalid `resolution`, `limit` or `cursor` returns `400`.

**Response**

```json
{
  "publicKey": "G...",
  "days": 30,
  "snapshots": [
    {
      "timestamp": 1716729600000,
      "totalValue": 102.34,
      "totalEarned": 2.34,
      "vaults": [
        {
          "vaultId": "blend-usdc-variable",
          "protocol": "blend",
          "value": 102.34,
          "earned": 2.34
        }
      ]
    }
  ]
}
```

`value` is the current worth of the holding and `earned` is cumulative yield (the same figures `GET /positions/:publicKey` reports as `deposited` and `earned`). An empty `snapshots` array means no history has been captured yet, not an error; `503` means the store could not be read.

**How snapshots are captured.** A snapshot is written (at most one per user per 30 minutes) whenever `GET /positions/:publicKey` succeeds, which also registers the wallet as tracked. `POST /api/v1/keepers/snapshot` (cron-authenticated, hourly via `.github/workflows/keepers.yml`) then snapshots up to 200 tracked wallets per run so history keeps accruing between visits. The last 90 days (2160 snapshots) are kept per wallet. Storage is the same Upstash Redis as the keepers (`UPSTASH_REDIS_REST_URL`/`_TOKEN`); without it the store is per-process and history does not persist. An event indexer was not chosen because it cannot reconstruct yield accrual between deposits and withdrawals.

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

The `xdr` field is a base64-encoded unsigned `TransactionEnvelope`. The `fee` is the assembled transaction's total fee in stroops, including the inclusion fee. The client must forward the XDR to the wallet for signing before submitting.

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

For both deposit and withdraw, an omitted `min_shares_out` or `min_usdc_out` is no longer treated as zero. The API prices the action with the same simulation as `POST /api/v1/tx/quote` and applies the quote's `recommendedMinimum` (the expected output less the default slippage), so the transaction is protected without the client choosing a floor.

### `POST /api/v1/tx/quote`

Prices a deposit or withdrawal without building a transaction.

**Request**

```json
{
  "action": "deposit",
  "walletAddress": "G...",
  "vaultId": "blend-usdc-variable",
  "amount": "100.00"
}
```

`action` is `deposit` or `withdraw`. A deposit requires `amount` and a withdrawal requires `shares`. Missing or malformed fields return `400`.

**Response**

```json
{
  "action": "deposit",
  "expectedShares": "98.5",
  "recommendedMinimum": "98.0075",
  "slippageBps": 50,
  "fee": "0",
  "ledger": 123456
}
```

A withdrawal returns `expectedAssets` in place of `expectedShares`, and `fee` is the performance fee in USDC. `recommendedMinimum` is the expected output reduced by `slippageBps`. A paused vault returns `400` for deposits. The quote is a simulation at the reported `ledger`, so it can differ from the executed result.

### `POST /api/v1/tx/add-trustline`

Builds an unsigned transaction that adds a trustline for each classic Stellar asset the caller doesn't already hold: USDC always, and mUSDC too on any network where `MUSDC_ISSUER` is still set (only true before a [#578](https://github.com/drydocs/meridian/issues/578) cutover; mUSDC is now a custom SEP-41 token, not a classic asset, so it needs no trustline on a network deployed against the new contract). Must be submitted before a first deposit, on whichever assets it covers. Throws if every required trustline already exists.

**Request**

```json
{ "walletAddress": "G..." }
```

**Response**

```json
{ "xdr": "AAAAAgAAAAA..." }
```

### `POST /api/v1/tx/submit`

Submits a wallet-signed XDR to the Stellar network.

**Request**

```json
{ "xdr": "AAAAAgAAAAA..." }
```

**Response**

```json
{ "hash": "abc123..." }
```

A `PENDING` or `DUPLICATE` status from the Stellar RPC is treated as success and the hash is returned. An `ERROR` status returns 500.

### `GET /api/v1/keepers/health`

Read-only status of both scheduled keepers, for the admin dashboard's Keeper Health card ([#615](https://github.com/drydocs/meridian/issues/615)). It is public, the same as `/api/v1/vaults`, and it reports on runs already recorded elsewhere, never triggers one, and holds no signing authority.

**Response**

```json
{
  "keepers": [
    {
      "id": "accrual",
      "intervalMs": 900000,
      "lastSuccessMs": 1716729600000,
      "healthy": true
    },
    {
      "id": "migration",
      "intervalMs": 3600000,
      "lastSuccessMs": null,
      "healthy": false
    }
  ],
  "checkedAt": "2026-05-26T12:00:00.000Z"
}
```

`lastSuccessMs` is `null` until that keeper's endpoint (`/api/v1/keepers/accrue` or `/rebalance`) has completed a run with zero failures at least once. See `keeper-heartbeat.ts` for the definition. `healthy` is `false` whenever `lastSuccessMs` is `null` or more than 2x the keeper's own schedule interval old, matching `.github/workflows/keepers.yml`'s cron cadence.

### `GET /api/v1/admin/vault-state`

Read-only coordinator vault state for the admin dashboard's Vault State card ([#615](https://github.com/drydocs/meridian/issues/615)): active adapter/protocol, total shares, total assets, and the pause flag. It is public, for the same reason as `/api/v1/keepers/health`, and it exposes the same on-chain data `/api/v1/vaults` already surfaces, just reshaped for the admin view.

**Response**

```json
{
  "protocol": "blend",
  "adapterId": "CADAPTER...",
  "totalShares": 12345.67,
  "totalAssets": 12890.12,
  "paused": false
}
```

Returns 404 if no Meridian coordinator vault is configured for the current network, or 503 if the on-chain read fails.

## Serverless vs Fastify

Both implementations share the same handler logic and import from the same workspace packages (`@meridian/shared`, `@meridian/stellar-sdk-helpers`).

The Vercel functions (`api/v1/`) import workspace packages that are pre-built into self-contained JS bundles by `scripts/build-vercel.sh` before deployment. The build script runs esbuild on each package's entry point with `--bundle --packages=external`, inlining all relative imports while leaving npm packages external. Vercel then bundles the resulting `dist/index.js` files alongside the function handlers at deploy time.

The Fastify server (`apps/api-local/`) runs the same packages directly via `tsx`, which handles TypeScript natively in the development process.

## Vault ID to contract address mapping

The vault contract's `deposit`/`withdraw` take no protocol-selection parameter. Which protocol a deposit reaches is fixed by whichever adapter the target vault instance has set, not by anything passed in the call. Building a deposit transaction therefore resolves `vaultId` directly to the specific deployed vault contract address to call, via the mapping in `packages/stellar-sdk-helpers/src/known-pools.ts`:

This adapter-based model uses no separate on-chain router contract; see [ADR-0002](./adr/0002-no-onchain-router.md) and [ADR-0001](./adr/0001-one-vault-per-asset.md).

| Vault ID prefix | Resolves to                                                |
| --------------- | ---------------------------------------------------------- |
| `blend-`        | A vault instance with `BlendAdapter` set as its adapter    |
| `defindex-`     | A vault instance with `DefindexAdapter` set as its adapter |

Any unrecognized `vaultId` returns a 500 with a clear mapping error.
