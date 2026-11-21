# API Error Reference

Meridian provides a structured and predictable error handling interface across both its production Vercel serverless functions (`api/v1/`) and local Fastify server (`apps/api-local/`).

Every API response with an HTTP status code of `400` or higher returns a consistent JSON error envelope containing a machine-readable error code, human-readable message, and a unique request identifier.

## Error Response Envelope

All error responses share the following format:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "walletAddress: Invalid input: expected valid Stellar address",
    "requestId": "support-2026.11:a4f8c9b2"
  }
}
```

### Envelope Fields

| Field             | Type     | Description                                                                                               |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `error.code`      | `string` | Machine-readable error code identifying the category or specific failure reason.                          |
| `error.message`   | `string` | Human-readable explanation of the error, sanitized for safe display to client applications.               |
| `error.requestId` | `string` | Stable request identifier corresponding to the `X-Request-ID` HTTP header for tracing and support triage. |

> Additional resource-specific fields (such as `vaultId` on a `NOT_FOUND` error) may accompany the envelope at the root level for backward compatibility.

---

## HTTP Status Codes

The API uses standard HTTP response codes to indicate the general category of the result:

| Status Code | Default Error Code    | Category            | Retryable            | Description                                                                                            |
| ----------- | --------------------- | ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `400`       | `VALIDATION_ERROR`    | Bad Request         | No (unless modified) | Request payload failed schema validation, contained invalid parameters, or failed contract simulation. |
| `401`       | `UNAUTHORIZED`        | Unauthorized        | No                   | Caller lacks required credentials or authentication tokens where mandatory.                            |
| `403`       | `FORBIDDEN`           | Forbidden           | No                   | Caller is authenticated but lacks required administrative permissions.                                 |
| `404`       | `NOT_FOUND`           | Not Found           | No                   | Target resource (e.g. `vaultId`, route action, or admin resource) does not exist.                      |
| `405`       | `METHOD_NOT_ALLOWED`  | Method Not Allowed  | No                   | HTTP request method is not supported for the requested route (e.g. `POST` on a read-only endpoint).    |
| `429`       | `RATE_LIMITED`        | Too Many Requests   | Yes (with backoff)   | Client IP has exceeded the allowed rate limit threshold (100 requests per 60-second sliding window).   |
| `500`       | `INTERNAL_ERROR`      | Internal Error      | Conditional          | Server encountered an unhandled exception, upstream RPC rejection, or transaction build failure.       |
| `503`       | `SERVICE_UNAVAILABLE` | Service Unavailable | Yes (with backoff)   | An essential upstream service (e.g. rate-limiter Redis store or RPC node) is temporarily unreachable.  |

---

## API Error Code Catalog

The table below catalogs each standard error code, its conditions, retryability, and recommended client handling:

| Error Code                  | HTTP Status | Condition / Root Cause                                                                                      | Retryable                  | Recommended Client Action                                                                               |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`          | `400`       | Zod schema validation failed for the request body or query parameters (e.g. missing fields, invalid types). | No                         | Inspect `error.message` for specific parameter validation rules; correct payload before retrying.       |
| `INVALID_PUBLIC_KEY`        | `400`       | Provided Stellar account address fails strkey formatting or public key checksum verification.               | No                         | Verify user wallet address format (starts with `G...`, 56 characters ed25519) before sending.           |
| `INVALID_PARAMETER`         | `400`       | Query or path argument violates constraint (e.g. non-positive integer `days` on history routes).            | No                         | Provide valid parameter within allowed bounds and resubmit.                                             |
| `MISSING_TRUSTLINE`         | `400`       | User account does not have required Stellar asset trustlines (e.g. USDC trustline missing).                 | No (until trustline added) | Prompt user to invoke `/api/v1/tx/add-trustline` and sign the trustline transaction before retrying.    |
| `CONTRACT_SIMULATION_ERROR` | `400`       | On-chain contract simulation failed due to a user-correctable condition (slippage, pause, balance).         | Conditional                | See [Contract Simulation Errors](#contract-simulation-errors-surfaced-by-api) for specific guidance.    |
| `NOT_FOUND`                 | `404`       | The requested `vaultId` is unmapped or unknown, or the route action does not exist.                         | No                         | Verify target vault identifier against `/api/v1/vaults` and ensure route path is correct.               |
| `METHOD_NOT_ALLOWED`        | `405`       | Request made using an HTTP verb not permitted by the endpoint (e.g. `POST` on read-only route).             | No                         | Switch request method to the permitted verb specified in the `Allow` response header (`GET` or `POST`). |
| `RATE_LIMITED`              | `429`       | Client exceeded the rate limit of 100 requests per minute from the originating IP address.                  | Yes                        | Throttle outbound requests and apply exponential backoff before retrying.                               |
| `INTERNAL_ERROR`            | `500`       | Unexpected server failure, Horizon RPC submission timeout, or unhandled internal exception.                 | Conditional                | Retry once after a short delay; if failure persists, report `requestId` to Meridian support.            |
| `SERVICE_UNAVAILABLE`       | `503`       | Distributed rate limiter or backing RPC infrastructure is temporarily degraded or unreachable.              | Yes                        | Wait and retry request with randomized jitter backoff.                                                  |

---

## Contract Simulation Errors Surfaced by API

When building transaction envelopes (`/api/v1/tx/deposit`, `/api/v1/tx/withdraw`), the API simulates transactions against Soroban RPC. Rejections caused by user-correctable conditions are mapped to HTTP `400` with clear instructions rather than returning generic 500 errors:

| Contract Error Code          | Error Message                                                                 | Root Cause                                                                               | Retryable           | Recommended Client Action                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `3` (`DepositsPaused`)       | `Deposits are currently paused. Try again later.`                             | Vault admin has temporarily paused deposits on this vault instance.                      | Yes (after unpause) | Inform user that deposits are temporarily suspended; retry after the vault is unpaused.             |
| `7` (`InsufficientShares`)   | `Insufficient shares for this withdrawal.`                                    | User balance holds fewer shares than requested in the withdrawal operation.              | No                  | Query user position via `/api/v1/positions/:publicKey` and adjust shares to available balance.      |
| `15` (`MinimumAssetsNotMet`) | `Withdrawal returned less USDC than your minimum. Adjust slippage and retry.` | Slippage tolerance was breached because received asset amount fell below `min_usdc_out`. | Yes                 | Increase slippage tolerance parameter or calculate fresh minimum output against current pool depth. |
| `18` (`SlippageExceeded`)    | `Slippage tolerance exceeded. Adjust slippage and retry.`                     | Slippage tolerance was breached because minted shares fell below `min_shares_out`.       | Yes                 | Increase slippage tolerance parameter or recalculate fresh minimum shares output.                   |

---

## Endpoint Error Matrix

### Transaction Endpoints (`/api/v1/tx/*`)

- **`POST /api/v1/tx/deposit`**:
  - `400 VALIDATION_ERROR`: Missing or malformed `walletAddress`, `vaultId`, `amount`, or `min_shares_out`.
  - `400 MISSING_TRUSTLINE`: Account is missing USDC trustline.
  - `400 CONTRACT_SIMULATION_ERROR`: Vault deposits paused (`3`) or slippage exceeded (`18`).
  - `500 INTERNAL_ERROR`: Failed to build deposit transaction.
- **`POST /api/v1/tx/withdraw`**:
  - `400 VALIDATION_ERROR`: Missing or malformed `walletAddress`, `vaultId`, `shares`, or `min_usdc_out`.
  - `400 MISSING_TRUSTLINE`: Account is missing USDC trustline.
  - `400 CONTRACT_SIMULATION_ERROR`: Insufficient shares (`7`) or withdrawal minimum not met (`15`).
  - `500 INTERNAL_ERROR`: Failed to build withdraw transaction.
- **`POST /api/v1/tx/add-trustline`**:
  - `400 VALIDATION_ERROR`: Malformed `walletAddress`.
  - `500 INTERNAL_ERROR`: Failed to build trustline transaction or trustline already exists.
- **`POST /api/v1/tx/submit`**:
  - `400 VALIDATION_ERROR`: Missing or invalid base64 `xdr` transaction string.
  - `500 INTERNAL_ERROR`: Transaction failed on-chain submission (e.g. `tx_bad_auth`, `tx_insufficient_fee`).

### Vaults Endpoints (`/api/v1/vaults/*`)

- **`GET /api/v1/vaults`**:
  - `500 INTERNAL_ERROR`: Failed to fetch live vault metrics and APY from DeFiLlama/Horizon.
- **`GET /api/v1/vaults/:vaultId`**:
  - `404 NOT_FOUND`: Specified `vaultId` is not found in known pools or registered vaults.
  - `500 INTERNAL_ERROR`: Failed to read vault details.

### Positions Endpoints (`/api/v1/positions/*`)

- **`GET /api/v1/positions/:publicKey`**:
  - `400 INVALID_PUBLIC_KEY`: Provided public key is not a valid 56-character Stellar account ID.
  - `500 INTERNAL_ERROR`: Failed to read on-chain share balances across registered vaults.
- **`GET /api/v1/positions/:publicKey/history`**:
  - `400 INVALID_PUBLIC_KEY`: Invalid Stellar public key.
  - `400 INVALID_PARAMETER`: `days` parameter is missing or non-positive.
  - `500 INTERNAL_ERROR`: Failed to query historical position records.

### Admin Endpoints (`/api/v1/admin/*`)

- **`GET /api/v1/admin/health`**:
  - `500 INTERNAL_ERROR`: Failed to inspect keeper heartbeat timestamps.
- **`GET /api/v1/admin/vault-state`**:
  - `404 NOT_FOUND`: No Meridian coordinator vault configured for the active network.
  - `503 SERVICE_UNAVAILABLE`: On-chain read from coordinator vault contract failed.
- **`GET /api/v1/admin/history`**:
  - `404 NOT_FOUND`: Vault not found or missing contract address.
  - `500 INTERNAL_ERROR`: Failed to fetch admin events history from Horizon.

---

## Client Integration Guidance

1. **Inspect `X-Request-ID`**: Always extract and log the `X-Request-ID` header from error responses. When reporting unexpected `500` errors, include this ID for rapid log triage.
2. **Handle Slippage Gracefully**: Catch contract simulation errors for codes `15` and `18` to present an inline slippage adjustment prompt to users rather than displaying generic failure banners.
3. **Respect Rate Limits**: Upon receiving `429 RATE_LIMITED`, wait at least 5 to 10 seconds before attempting retries, implementing exponential backoff with jitter.
4. **Trustline Checks**: Before initiating deposit transactions, check if the response indicates `USDC trustline missing` and seamlessly redirect users to the trustline creation flow.
