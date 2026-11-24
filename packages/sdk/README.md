# @meridian/sdk

TypeScript SDK for building on Meridian: vault deposits and withdrawals, keeper transaction submission with retry and fee escalation, and the Blend adapter client. It runs on top of `@stellar/stellar-sdk`.

The package is at `0.1.0`. It exports `SDK_VERSION`, `VaultBase`, `BlendAdapterClient`, the typed error classes, the retry policy and the instrumentation hooks documented below. The keeper modules are tracked in #803 to #807.

## Install

```bash
pnpm add @meridian/sdk @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a peer dependency, so your app and the SDK share one copy.

Inside this monorepo, depend on it through the workspace:

```json
{
  "dependencies": {
    "@meridian/sdk": "workspace:*"
  }
}
```

## Usage

The package ships both ESM and CommonJS builds with type declarations:

```ts
import { SDK_VERSION } from "@meridian/sdk";
```

```js
const { SDK_VERSION } = require("@meridian/sdk");
```

## Blend adapter

`BlendAdapterClient` reads a configured Meridian Blend adapter and the pool it
supplies to. It makes the same contract calls as the rate source and accrual
keeper (`get_protocol`, `get_pool`, `total_assets`, `accrue`), and never signs
or submits anything.

```ts
import { BlendAdapterClient } from "@meridian/sdk";

const blend = new BlendAdapterClient({
  adapterId: adapterContractId,
  network, // { network, rpcUrl, passphrase }, as for VaultBase
});

const { poolId, protocol } = await blend.discover();
const reserve = await blend.getReserve(usdcSac); // typed rates and totals
const apyBps = await blend.getSupplyApy(usdcSac); // e.g. 512 for 5.12%
const positions = await blend.getPositions(caller);
const tx = await blend.buildAccrueTx(caller); // unsigned XDR
```

Amounts are in stroops and rates are decimals (`0.05` is 5%) unless the field
name ends in `Bps`. An adapter that has not been initialized with a pool throws
`UnsupportedError`; a pool response that doesn't match the expected shape throws
`MalformedPoolResponseError`.

## Errors

Every error the SDK throws on purpose extends `MeridianError`, which carries a
stable `code` and a `retryable` flag, so you never need to string-match
messages. Messages are unchanged from earlier releases.

| Class              | `code`        | `retryable` | Thrown when                                                       |
| ------------------ | ------------- | ----------- | ----------------------------------------------------------------- |
| `ValidationError`  | `VALIDATION`  | no          | an argument is rejected before any network call                   |
| `SimulationError`  | `SIMULATION`  | no          | the simulation is rejected (`contractCode` holds `#N` if known)   |
| `SlippageError`    | `SLIPPAGE`    | no          | the contract's slippage guard tripped (extends `SimulationError`) |
| `NetworkError`     | `NETWORK`     | yes         | DNS/connection failures, HTTP 429 or 5xx from the RPC             |
| `TimeoutError`     | `TIMEOUT`     | yes         | an RPC call or `timeouts.operationMs` budget is exceeded          |
| `UnsupportedError` | `UNSUPPORTED` | no          | the deployment or on-chain state cannot serve the request         |
| `MeridianError`    | `UNKNOWN`     | no          | anything else; the original error is on `cause`                   |

```ts
import { VaultBase, ErrorCode, isMeridianError } from "@meridian/sdk";

try {
  await vault.deposit(assets, receiver, minSharesOut);
} catch (err) {
  if (isMeridianError(err) && err.code === ErrorCode.SLIPPAGE) {
    // re-quote and try again
  }
}
```

`classifyError(err)` maps any thrown value onto this taxonomy. Errors from
`@meridian/stellar-sdk-helpers` are now wrapped: the original, including
`ContractSimulationError`, is available as `error.cause`.

## Timeouts and retries

```ts
const config: VaultConfig = {
  contractId,
  network,
  timeouts: {
    rpcMs: 12_000, // Soroban RPC client timeout (default 12000)
    operationMs: 30_000, // optional budget per SDK call attempt (default: none)
  },
  retry: {
    maxAttempts: 3, // including the first attempt
    baseDelayMs: 200, // doubles each retry, capped by maxDelayMs (5000)
    jitter: true,
    // shouldRetry: (error, attempt) => error.retryable  (default)
    // retryTxBuilders: false
  },
};
```

Retries are **off by default**. With a `retry` policy, read-only methods retry
on `retryable` errors; methods that build a transaction (`deposit`,
`withdraw`, `setPaused`, `setAdapter`, `beginMigration`, `migrateAdapter`) only
retry when you also set `retryTxBuilders: true`. The SDK never signs or submits
anything. Use `withRetry(fn, policy)` to retry your own steps explicitly.

## Instrumentation hooks

```ts
const config: VaultConfig = {
  contractId,
  network,
  hooks: {
    onRequestStart: (e) => log("start", e.operation, e.attempt),
    onRequestSuccess: (e) => metrics.timing(e.operation, e.durationMs),
    onRequestError: (e) => log("error", e.operation, e.error.code),
    onRetry: (e) => log("retry", e.operation, e.delayMs),
  },
};
```

Events carry `operation`, sanitized `params`, `attempt`, and (where relevant)
`durationMs`, `delayMs` and a `SanitizedError` (`name`, `code`, `retryable`,
first message line). Before a hook runs, the SDK redacts values under keys that
look sensitive (`secret`, `seed`, `token`, `api key`, `auth`, `signature`,
`xdr`, ...), Stellar secret seeds, bearer tokens, long base64 blobs, and URLs
(reduced to their host). The raw `cause` is never passed to hooks, bigints are
rendered as strings, and a hook that throws or rejects is ignored. One public
call fires one event set per attempt, not one per internal RPC read.
`redact()` and `redactString()` are exported for your own logging.

## Development

```bash
pnpm --filter @meridian/sdk build      # dist/ with .js, .cjs, .d.ts and .d.cts
pnpm --filter @meridian/sdk test
pnpm --filter @meridian/sdk typecheck
```

## Versioning

The SDK follows [Semantic Versioning](https://semver.org/). While the version is `0.x`, a minor bump may include breaking API changes; patch bumps never do. `SDK_VERSION` always matches the `version` field in `package.json`, and a test enforces this.

## License

MIT, see [LICENSE](./LICENSE).
