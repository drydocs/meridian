<p align="center">
  <img src="apps/web/public/brand/logo-mark.svg" alt="Meridian" width="96" />
</p>

# Meridian

**Stablecoin yield aggregator on Stellar, built for emerging market savers.**

Meridian is a savings dashboard that surfaces live USDC yields across [Blend](https://blend.capital) and [DeFindex](https://defindex.io) on the Stellar network and builds the deposit transactions your own wallet signs. Its goal is to route deposits to the highest-yielding vault automatically. It targets users in West Africa and other emerging markets where dollar-denominated savings yield meaningful real returns compared to local currency alternatives.

Submitted to the **Drips Stellar Wave Program**.

---

## Project status

Meridian is **live on Stellar mainnet**. Real USDC deposits are routed through a deployed, independently-verified `MeridianVault` into Blend Capital's mainnet USDC pool. Be clear-eyed about what that does and doesn't mean: **no independent security audit has been completed yet**, and the vault's `ADMIN` key is currently a single plain key, not yet hardware-backed or multisig. The app's own risk disclosure (shown and required before a first deposit) says this plainly rather than burying it here.

**Working today**

- Live on mainnet and testnet: real USDC deposits into the `MeridianVault` coordinator contract, forwarded to its active adapter (`BlendAdapter`) and supplied straight into a real Blend pool. You receive mUSDC shares representing the position, with no Meridian-controlled custody of the underlying funds.
- Live APY / TVL feed across Stellar stablecoin pools (via DeFiLlama on mainnet; direct on-chain queries on testnet, since DeFiLlama doesn't index it) with a risk heuristic
- Non-custodial signing flow: the API builds an unsigned Soroban XDR, and your wallet signs and submits it, so keys never leave the browser. Freighter, LOBSTR, and xBull are wired up in the wallet picker (Albedo has an implemented, tested adapter but isn't exposed in the picker yet).
- Live TVL and per-address position reads directly from the vault (`get_total_assets`, `get_position`)
- Best-rate routing: the API recommends the highest-APY vault it can actually deposit into, skipping display-only protocols and pools flagged risky
- Protocol-agnostic adapter architecture: `MeridianVault` (ERC-4626-style share accounting hardened against the first-depositor inflation attack, pause + two-step admin-rotation rails), `BlendAdapter` (live), and a `DefindexAdapter` contract (built and tested, not yet wired to any live vault). Swapping which protocol a vault routes to is an admin-only `set_adapter` call, with no vault redeploy required. The vault's `migrate_adapter` entry point atomically moves the vault's entire position to a new adapter in one slippage-bounded transaction behind a ~1-day timelock, with no manual withdraw-then-deposit cycle. All contracts have unit test coverage.
- mUSDC is a custom SEP-41 share token, not a plain Stellar Asset Contract: transfers call back into the vault so cost basis and entry time split correctly between sender and receiver
- Per-position yield earned: cost-basis tracking via `get_principal`, surfaced in the dashboard alongside the current position value
- Admin dashboard: keeper health, live vault state, and an on-chain admin-action history feed, all reading directly from chain rather than a cached view
- Public Contract Status page: anyone can verify the deployed addresses and parameters without reading source or querying RPC directly
- English and French localisation
- Scheduled keepers on GitHub Actions cron: an accrual keeper (refreshes cached yield from Blend, funded and running in production) and a migration keeper (moves the vault's position to a better-yielding adapter automatically, fully built and tested, but its production key hasn't been granted admin authority yet, pending the `ADMIN` multisig decision above, so it isn't yet active on mainnet)

**In progress**

- An admin-event alert keeper exists and posts to a webhook on pause/admin-transfer/adapter-change/migration events, but that webhook isn't configured in production yet. It currently runs as a clean no-op, not an active alert.
- Deposit/withdraw against a real DeFindex vault through `DefindexAdapter`: the adapter contract and transaction builders are implemented, gated behind `DEFINDEX_VAULT_ID` until a real vault is wired
- `ADMIN` key custody (hardware-backed or multisig) and a written incident-response runbook, both prerequisites the mainnet deployment shipped ahead of rather than waited on
- Third-party security audit

Until a DeFindex vault is configured, the DeFindex deposit path throws a configuration error rather than silently routing elsewhere. Track progress in the [Roadmap](#roadmap) and [open issues](../../issues).

---

## Why Meridian?

Inflation in many West African economies regularly exceeds 20 % annually. Access to USD savings accounts is limited by KYC friction and minimum balances. Stellar's low fees (< $0.01/tx), fast finality (5s), and USDC availability make it an ideal rails layer. Meridian removes the final UX barrier: users connect a wallet, see live APY across protocols, and deposit in three clicks.

---

## Architecture

```text
meridian/
├── apps/
│   ├── web/          # Vite + React 19 dashboard (TypeScript, Tailwind, Zustand)
│   ├── api-local/    # Fastify REST API (local dev only): builds Soroban txs, aggregates APY
│   ├── docs/         # Internal architecture and operations docs
│   └── landing/      # Marketing landing page
├── api/              # Vercel serverless functions (api/v1/...) — the production API
├── packages/
│   ├── api-core/             # Framework-agnostic route handlers shared by both servers
│   ├── stellar-sdk-helpers/  # Blend & DeFindex client wrappers
│   ├── shared/               # Zod schemas, constants, pure utils
│   └── contracts/            # Soroban smart contracts (Rust): vault, blend-adapter, defindex-adapter, adapter-common, musdc-token
└── scripts/          # deploy-testnet.sh / deploy-mainnet.sh (fresh stack), redeploy-blend-adapter.sh (swap adapter on a live vault)
```

This is a **pnpm + Turborepo** monorepo. All packages are TypeScript-first with strict mode enabled.

### Data flow

```text
User browser
  └─► Vite + React frontend
        └─► Vercel Serverless Functions (builds unsigned XDR)
              └─► MeridianVault coordinator contract
                    └─► active adapter (BlendAdapter today) ─► underlying protocol pool
                              │
                         Stellar RPC (Soroban)
```

In production, API routes are Vercel serverless functions (`api/v1/...`). The Fastify server in `apps/api-local` is used for local development only.

The API never holds private keys. It builds an unsigned Soroban transaction, returns the XDR, and the frontend forwards it to the user's connected wallet (Freighter, LOBSTR, or xBull) for signing and submission. See [`docs/signing-flow.md`](docs/signing-flow.md) for the full sequence diagram and endpoint reference.

---

## Tech Stack

| Layer           | Technology                                              |
| --------------- | ------------------------------------------------------- |
| Frontend        | Vite 8, React 19, Tailwind CSS, Zustand, TanStack Query |
| Backend (prod)  | Vercel Serverless Functions, Zod validation             |
| Backend (local) | Fastify                                                 |
| Blockchain      | Stellar Soroban, `@stellar/stellar-sdk` v14             |
| Protocols       | Blend Capital, DeFindex                                 |
| Contracts       | Rust / Soroban SDK                                      |
| Monorepo        | pnpm workspaces, Turborepo                              |
| CI              | GitHub Actions                                          |

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm i -g pnpm`)
- Rust + `wasm32v1-none` target (for contracts)
- Stellar CLI (`cargo install stellar-cli`)

### Install

```bash
git clone https://github.com/drydocs/meridian.git
cd meridian
pnpm install
```

### Configure

```bash
cp .env.example .env
# Set DEFINDEX_VAULT_ID if you have a DeFindex vault configured; leave empty otherwise
```

### Run locally

```bash
# Start API + web in parallel
pnpm dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:3001>
- Health: <http://localhost:3001/health>

### Run tests

```bash
pnpm test
```

### Build for production

```bash
pnpm build
```

---

## Protocols

### Blend Capital

Blend is a permission-less lending protocol on Stellar. Meridian reads pool APY from Blend's on-chain pool data entries and builds deposit/withdraw transactions via Soroban contract invocations. See [`packages/stellar-sdk-helpers/src/blend.ts`](packages/stellar-sdk-helpers/src/blend.ts).

### DeFindex

DeFindex is a yield-strategy vault protocol on Stellar that composes multiple yield sources behind a single share token. Meridian treats each DeFindex vault as a single aggregated position. See [`packages/stellar-sdk-helpers/src/defindex.ts`](packages/stellar-sdk-helpers/src/defindex.ts).

---

## Contributing

We welcome contributions. See [open issues](../../issues) for a range of tasks across TypeScript, Rust/Soroban, and UI.

1. Fork the repo and create a feature branch: `git checkout -b feat/your-feature`
2. Follow the existing code style (no comments unless WHY is non-obvious)
3. Run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR
4. Reference the relevant GitHub issue in your PR description

Issues are tagged `good first issue`, `medium`, and `hard`. Pick your level.

---

## Roadmap

### Shipped: deposit, withdraw, and earn, on mainnet

Non-custodial USDC deposits into the `MeridianVault` coordinator contract, live end-to-end for Blend via `BlendAdapter` on both testnet and Stellar mainnet. Wallet connects in one click (Freighter, LOBSTR, or xBull), the best-rate vault is selected automatically, and the signed transaction never leaves the browser. Live APY and TVL across protocols with risk-tier labelling. Withdraw at any time, no lock-up. DeFindex support is built (`DefindexAdapter`) but not yet wired to a live vault on either network.

### Shipped: yield history and position analytics (partial)

Per-position yield tracking with a cost-basis model is shipped: users already see cumulative earned alongside their current balance. Remaining: a yield history chart broken down by protocol, entry time, and cumulative earned over time. Position-level analytics that work whether funds are in Blend, DeFindex, or split across both.

### Shipped: automatic yield routing (built and tested, not yet live on mainnet)

A scheduled keeper that compares live rates across a vault's candidate adapters and calls the vault's `migrate_adapter` when a candidate clears a configured improvement threshold is built and tested end to end (see [#469](../../issues/469)): rate comparison for both Blend and DeFindex, discovery, retry, deadline-budget handling, and slippage/threshold-bounded submission all work. What's left is operational, not code: the production migration-keeper key needs admin authority over the mainnet vault, which is deliberately blocked on deciding `ADMIN`'s custody model first (see "Project status" above) rather than handed over as a shortcut.

### Now: mainnet hardening

Third-party security audit, `ADMIN` key custody (hardware-backed or multisig), a written incident-response runbook, and the admin-event alert keeper's production webhook. All are real gaps on a live vault, tracked openly rather than assumed done because mainnet shipped. See [`apps/docs/operations/mainnet-deployment.md`](apps/docs/operations/mainnet-deployment.md)'s go-live checklist for the current state of each. A production-grade rate-limit and caching layer for real user load, and a mobile-first UI pass targeting low-end Android devices common in the target market, are also still ahead.

---

## License

MIT
