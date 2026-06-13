# Changelog

All notable changes to Meridian will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Security

- **MeridianVault: fix first-depositor share inflation attack.** Share price is now
  computed against a virtual shares/assets offset (OpenZeppelin ERC-4626 mitigation)
  instead of the raw on-chain USDC balance, so an attacker can no longer donate USDC
  directly to the contract to skim later depositors via rounding. Added the
  `inflation_attack_is_unprofitable` regression test.

### CI

- Re-enabled the Soroban contract job (`cargo test` + wasm release build) now that
  `packages/contracts` has a `Cargo.toml`.

### Planned

- Freighter wallet adapter integration
- Live Blend Capital pool APY and TVL data
- Live DeFindex vault APY and TVL data
- APY aggregation API endpoint with Redis caching
- Unsigned Soroban deposit/withdraw transaction XDR builder
- Soroban router contract for atomic single-transaction rebalancing
- Yield history sparkline chart per vault
- French/English i18n with `react-i18next` and locale detection

---

## [0.1.0] - 2026-05-09

### Added

#### Infrastructure

- `pnpm` + Turborepo monorepo with `apps/web`, `apps/api`, `packages/shared`, `packages/stellar-sdk-helpers`, `packages/contracts`
- `pnpm-workspace.yaml` for correct pnpm workspace resolution
- Root `tsconfig.json` extended by all packages
- GitHub Actions CI workflow: lint, typecheck, and test across all packages
- ESLint with `@typescript-eslint` strict rules for web and API
- Dependabot configuration for npm and GitHub Actions dependencies
- `CONTRIBUTING.md` with branch naming, commit convention, and PR process
- `PULL_REQUEST_TEMPLATE.md` with type-of-change checklist and protocol context fields

#### Frontend (`apps/web`)

- Vite + React 18 frontend (migrated from Next.js 14)
- Tailwind CSS with PostCSS — dark theme palette
- `WalletConnect` component (placeholder, Freighter integration pending)
- `VaultCard` component — displays APY, TVL, asset, and protocol badge
- `VaultList` — renders 4 mock vaults (USDC/EURC across Blend and DeFindex)
- `PortfolioSummary` — total deposited, total earned, and per-position breakdown with mock data
- Zustand wallet store (`useWalletStore`)
- `apps/web/src/lib/api.ts` — typed `apiFetch` wrapper using `VITE_API_URL`

#### API (`apps/api`)

- Fastify 4 API skeleton with CORS and rate-limiting plugins
- `GET /api/v1/vaults` — stub returning empty vault list
- `GET /api/v1/vaults/:id` — stub returning 404
- `POST /api/v1/tx/deposit` — validates body with Zod; returns 501 pending implementation
- `POST /api/v1/tx/withdraw` — validates body with Zod; returns 501 pending implementation
- `GET /health` — liveness endpoint

#### SDK (`packages/stellar-sdk-helpers`)

- `getBlendPoolInfo(config)` — stub; decodes Blend pool APY + TVL (implementation pending)
- `buildBlendDepositTx(config, depositor, amount)` — stub; builds unsigned Soroban XDR (pending)
- `getDefindexVaultInfo(config)` — stub; decodes DeFindex vault APY + TVL (pending)
- `buildDefindexDepositTx(config, depositor, amount)` — stub; builds unsigned Soroban XDR (pending)
- `buildHorizonServer(config)` — returns a configured `Horizon.Server`
- `getAccountBalances(server, publicKey)` — fetches all balances for a Stellar account

#### Shared (`packages/shared`)

- `DepositRequestSchema` and `WithdrawRequestSchema` — Zod schemas shared by API and frontend
- `SUPPORTED_STABLECOINS`, `PROTOCOL_IDS`, `CONTRACT_ADDRESSES`, `STELLAR_NETWORKS` constants
- `formatUsdAmount(stroops)` — formats a bigint stroops value to a USD string
- `parseUsdAmount(display)` — parses a USD display string to bigint stroops
- `fromStroops(stroops)` — converts stroops bigint to a JavaScript number
- `shortenAddress(address)` — truncates a Stellar G-address for display

#### Contracts (`packages/contracts`)

- Package scaffold for Soroban Rust contracts (no Cargo.toml yet — pending)
- `scripts/deploy-testnet.sh` — placeholder deploy script for testnet

### Changed

- N/A — initial release

### Fixed

- N/A — initial release

---

[Unreleased]: https://github.com/drydocs/meridian/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/drydocs/meridian/releases/tag/v0.1.0
