# API Error Reference

Both API implementations, the Vercel functions in `api/v1/` and the local Fastify server in `apps/api-local/`, answer every failed request with the same JSON envelope and an `X-Request-ID` header. This page lists the codes that can appear, what causes them, and what a client should do.

## Error Response Envelope

Every response with an HTTP status of `400` or higher has this shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "walletAddress: Invalid input: expected valid Stellar address",
    "requestId": "support-2026.11:a4f8c9b2"
  }
}
```

| Field             | Type     | Description                                                                          |
| ----------------- | -------- | ------------------------------------------------------------------------------------ |
| `error.code`      | `string` | Machine-readable code. It is the default code for the HTTP status unless one is set. |
| `error.message`   | `string` | Explanation that is safe to show to a user.                                          |
| `error.requestId` | `string` | The value of the `X-Request-ID` response header.                                     |

Fields that belong to one failure stay at the root of the body next to `error`. For example, a deadline failure also carries `retryAfterSeconds`.

A client may send its own `X-Request-ID`. A well-formed value is echoed back, and the API generates a UUID otherwise. The ID is written to the structured server logs, so quote it when reporting a problem.

## HTTP Status Codes

Unless a route sets a more specific code, the code follows the status:

| Status Code | Default Error Code    | Retryable          | Description                                                          |
| ----------- | --------------------- | ------------------ | -------------------------------------------------------------------- |
| `400`       | `VALIDATION_ERROR`    | No                 | The body or query is invalid, or a contract rejection can be fixed.  |
| `401`       | `UNAUTHORIZED`        | No                 | A protected route did not receive valid credentials.                 |
| `403`       | `FORBIDDEN`           | No                 | The route refused the caller.                                        |
| `404`       | `NOT_FOUND`           | No                 | The vault, route action or resource does not exist.                  |
| `405`       | `METHOD_NOT_ALLOWED`  | No                 | The HTTP method is not supported. The `Allow` header lists the ones. |
| `413`       | `PAYLOAD_TOO_LARGE`   | No                 | The request body is larger than 10 KB.                               |
| `429`       | `RATE_LIMITED`        | Yes (with backoff) | The client exceeded the request limit for its IP address.            |
| `500`       | `INTERNAL_ERROR`      | Conditional        | An unexpected failure. Other 5xx statuses use the same code.         |
| `503`       | `SERVICE_UNAVAILABLE` | Yes (with backoff) | A required upstream service is unavailable or too slow.              |

Other `4xx` statuses use `HTTP_ERROR`.

## API Error Code Catalog

| Error Code                       | HTTP Status | Condition / Root Cause                                                                                                                                        | Retryable                      | Recommended Client Action                                                                                                  |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`               | `400`       | The request body or query failed validation, the public key is malformed, or the account has no trustline, or a user-correctable contract rejection occurred. | No (until the request changes) | Read `error.message`, fix the request and resend. For a missing USDC trustline call `POST /api/v1/tx/add-trustline` first. |
| `UNAUTHORIZED`                   | `401`       | A protected route did not receive valid credentials.                                                                                                          | No                             | Send the correct credentials.                                                                                              |
| `FORBIDDEN`                      | `403`       | The route refused the caller.                                                                                                                                 | No                             | Do not retry with the same caller.                                                                                         |
| `NOT_FOUND`                      | `404`       | The vault id, route action or resource does not exist.                                                                                                        | No                             | Check the identifier against `GET /api/v1/vaults`.                                                                         |
| `METHOD_NOT_ALLOWED`             | `405`       | The method is not allowed for the route.                                                                                                                      | No                             | Use a method listed in the `Allow` header.                                                                                 |
| `PAYLOAD_TOO_LARGE`              | `413`       | The request body is larger than 10 KB.                                                                                                                        | No                             | Send a smaller body.                                                                                                       |
| `HTTP_ERROR`                     | other `4xx` | A client error without a more specific code.                                                                                                                  | No                             | Read `error.message` and change the request.                                                                               |
| `RATE_LIMITED`                   | `429`       | The client IP exceeded the request limit.                                                                                                                     | Yes                            | Wait for the `Retry-After` header, then retry with exponential backoff and jitter.                                         |
| `INTERNAL_ERROR`                 | `500`       | An unexpected failure, for example a transaction build or submission error.                                                                                   | Conditional                    | Retry once after a short delay. If it persists, report the `requestId`.                                                    |
| `SERVICE_UNAVAILABLE`            | `503`       | A required upstream service is unavailable.                                                                                                                   | Yes                            | Retry with backoff and jitter.                                                                                             |
| `UPSTREAM_DEADLINE_EXCEEDED`     | `503`       | An upstream call, such as Soroban RPC, did not answer within its deadline.                                                                                    | Yes                            | Wait `retryAfterSeconds` from the body, then retry.                                                                        |
| `RATE_LIMIT_BACKEND_UNAVAILABLE` | `503`       | A fund-moving route requires the distributed rate limiter on deployed environments and it is not configured.                                                  | No (operator action)           | Report the `requestId`. An operator must configure the Upstash credentials.                                                |

## Contract Simulation Errors Surfaced by API

When a build route simulates a transaction and the vault rejects it for a reason the caller can fix, the API answers `400` with a readable message in `error.message`:

| Contract Error Code                   | Error Message                                                                                                       | Root Cause                                                      | Retryable           | Recommended Client Action                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------- | -------------------------------------------------- |
| `3` (`DepositsPaused`)                | `Deposits are currently paused. Try again later.`                                                                   | The vault admin paused deposits.                                | Yes (after unpause) | Tell the user deposits are paused and retry later. |
| `7` (`InsufficientShares`)            | `Insufficient shares for this withdrawal.`                                                                          | The wallet holds fewer shares than the withdrawal asks for.     | No                  | Refresh the position and request a smaller amount. |
| `15` (`MinimumAssetsNotMet`)          | `Withdrawal returned less USDC than your minimum. Adjust slippage and retry.`                                       | The payout fell below `min_usdc_out`.                           | Yes                 | Refresh the quote, widen the tolerance and retry.  |
| `18` (`SlippageExceeded`)             | `Slippage tolerance exceeded. Adjust slippage and retry.`                                                           | The minted shares fell below `min_shares_out`.                  | Yes                 | Refresh the quote, widen the tolerance and retry.  |
| `41` (`AdapterLiquidityInsufficient`) | `Insufficient liquidity in the underlying yield protocol for this withdrawal. Try a smaller amount or retry later.` | The yield protocol cannot currently pay out the requested USDC. | Yes                 | Offer a smaller withdrawal or retry later.         |

Every other contract error is treated as a server failure and answers `500` without the contract detail.

## Endpoint Error Matrix

Routes that call Soroban RPC can also answer `503 UPSTREAM_DEADLINE_EXCEEDED` when the upstream call is too slow.

- **`POST /api/v1/tx/deposit`**, **`POST /api/v1/tx/withdraw`**: `400` for invalid input, a missing trustline or a contract rejection from the table above, `500` when the transaction cannot be built.
- **`POST /api/v1/tx/add-trustline`**: `400` for a malformed wallet address, `500` when the transaction cannot be built.
- **`POST /api/v1/tx/quote`**: `400` for invalid input or a paused vault on a deposit quote, `500` when the simulation fails.
- **`POST /api/v1/tx/submit`**: `400` for a missing or invalid XDR, `202` when the network has not confirmed the transaction yet, `500` when submission fails.
- **`GET /api/v1/vaults/:vaultId`**: `404` when the vault id is unknown.
- **`GET /api/v1/positions/:publicKey`** and **`GET /api/v1/positions/:publicKey/history`**: `400` for a malformed public key or an invalid query parameter, `503` when the read fails.
- **`GET /api/v1/admin/vault-state`**: `404` when no Meridian vault is configured for the network, `503` when the contract read fails.
- **`GET /api/v1/admin/history`**: `404` when the vault is unknown or has no contract address.

Any route can answer `405` for an unsupported method and `429` when the client is rate limited.

## Client Integration Guidance

1. Log the `X-Request-ID` header, or `error.requestId`, from every failed response, and include it when reporting a problem.
2. Treat the codes `3`, `15` and `18` as a prompt to adjust slippage inline, not as a generic failure.
3. On `429`, wait for `Retry-After` and back off with jitter.
4. When a deposit fails because the account has no USDC trustline, send the user to the trustline step.
