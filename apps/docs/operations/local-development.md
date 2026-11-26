# Local Development

## Prerequisites

| Tool        | Version | Install                          |
| ----------- | ------- | -------------------------------- |
| Node.js     | ≥ 20    | [nodejs.org](https://nodejs.org) |
| pnpm        | ≥ 9     | `npm i -g pnpm`                  |
| Rust        | stable  | [rustup.rs](https://rustup.rs)   |
| Stellar CLI | latest  | `cargo install stellar-cli`      |

The Rust toolchain and Stellar CLI are only required if you are working on the Soroban contracts in `packages/contracts/`. Frontend and API work does not require them.

## Setup

```bash
git clone https://github.com/drydocs/meridian.git
cd meridian
pnpm install
```

## Running the full stack

```bash
pnpm dev
```

Turborepo starts all `dev` tasks in parallel:

- **Web** at `http://localhost:3000/app/` (Vite dev server with HMR)
- **API** at `http://localhost:3001` (Fastify with `tsx watch`)
- **Docs** at `http://localhost:3000/docs/` (VitePress, proxied from port 3002)

The Vite dev server proxies `/api/*` to `http://localhost:3001` and `/docs/*` to the VitePress dev server at port 3002.

## Running services individually

```bash
# Web only
pnpm --filter @meridian/web dev

# API only
pnpm --filter @meridian/api-local dev
```

## Health check

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

For API dependency checks, use `GET http://localhost:3001/api/v1/health/live`
for process liveness and `GET http://localhost:3001/api/v1/health/ready` for
readiness. Liveness does not contact external services. Readiness reports the
Soroban RPC, Upstash PING, position snapshot store, and build metadata
independently; it returns 503 if any required check fails. Without Upstash
credentials, local snapshot storage is identified as `in-memory`, while the
Upstash dependency is reported unhealthy and readiness returns 503. Set
`APP_VERSION` or use the default `0.1.0` to identify the running version.

## Running tests

```bash
pnpm test
```

To run tests for a single package:

```bash
pnpm --filter @meridian/shared test
pnpm --filter @meridian/stellar-sdk-helpers test
```

## Type checking

```bash
pnpm typecheck
```

## Linting

```bash
pnpm lint
```

## Building packages

If you edit a `packages/` library, rebuild it before the apps pick up the changes:

```bash
pnpm build
```

Or build a single package:

```bash
pnpm --filter @meridian/shared build
```

## Working with the contracts

`packages/contracts/` has three crates: `vault` (the coordinator) and two yield adapters, `blend-adapter` and `defindex-adapter`. Build and test them all together from the `contracts` package root, or individually:

```bash
cd packages/contracts

# Build every crate's WASM (outputs to target/wasm32v1-none/release/)
stellar contract build

# Run every crate's Rust tests
cargo test

# Or a single crate
cargo test --manifest-path blend-adapter/Cargo.toml
```

`stellar contract build` targets `wasm32v1-none`, not `wasm32-unknown-unknown`. Install the correct target with `rustup target add wasm32v1-none` if you haven't already.

See [Testnet Deployment](./testnet-deployment.md) for deploying the contracts to testnet, and [Vault Contract](../architecture/vault-contract.md) for how the vault and adapters fit together.

For contract storage keys and TTL/archival operations, see [Contract Storage and TTL Reference](../architecture/contract-storage.md).

## Wallet setup

Install a Stellar wallet browser extension (for example, [Freighter](https://freighter.app)) and switch it to **Testnet** mode. Fund your testnet account using [Stellar Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS).

The local API server targets testnet because `.env.example` pins `STELLAR_NETWORK=testnet` explicitly, not because testnet is the fallback: mainnet is now the default when `STELLAR_NETWORK` is unset at all, since the product is live there. Copy `.env.example` to `.env` (see "Environment setup" above) rather than skipping it, an environment that never loads `.env` targets mainnet by default, not testnet.
