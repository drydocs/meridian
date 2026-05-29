# Monorepo Structure

Meridian is a pnpm workspace managed by Turborepo.

```
meridian/
├── api/                          # Vercel serverless functions (production API)
│   └── v1/
│       ├── vaults/               # GET /api/v1/vaults, GET /api/v1/vaults/:id
│       │   ├── index.ts
│       │   ├── [vaultId].ts
│       │   └── _shared.ts        # DeFiLlama fetcher, pool risk logic
│       ├── tx/                   # POST /api/v1/tx/deposit|withdraw|submit
│       │   ├── deposit.ts
│       │   ├── withdraw.ts
│       │   ├── submit.ts
│       │   └── _shared.ts        # Soroban XDR builder
│       └── positions/
│           └── [publicKey].ts    # GET /api/v1/positions/:publicKey
│
├── apps/
│   ├── web/                      # Vite + React 18 dashboard
│   │   └── src/
│   │       ├── components/
│   │       │   ├── dashboard/VaultPanel.tsx   # Main deposit/withdraw UI
│   │       │   └── onboarding/WalletConnect.tsx
│   │       ├── hooks/
│   │       │   ├── useVaults.ts
│   │       │   ├── usePositions.ts
│   │       │   ├── useVaultActions.ts
│   │       │   └── useWalletConnect.ts
│   │       ├── lib/
│   │       │   ├── api.ts        # Typed API client
│   │       │   └── wallet.ts     # Freighter adapter
│   │       └── store/wallet.ts   # Zustand wallet state
│   │
│   └── api/                      # Fastify server (local development only)
│       └── src/
│           ├── index.ts
│           ├── routes/
│           │   ├── vaults.ts
│           │   ├── positions.ts
│           │   └── tx.ts
│           └── services/vaults.ts
│
├── packages/
│   ├── stellar-sdk-helpers/      # Stellar/Soroban client wrappers
│   │   └── src/
│   │       ├── tx.ts             # XDR builders (deposit, withdraw, submit)
│   │       ├── vaults.ts         # fetchAllVaults aggregator
│   │       ├── blend.ts          # Blend Capital helpers
│   │       ├── defindex.ts       # DeFindex helpers
│   │       ├── defilamma.ts      # DeFiLlama pool fetcher
│   │       ├── horizon.ts        # Horizon server helper
│   │       └── known-pools.ts    # Curated pool registry
│   │
│   ├── shared/                   # Cross-package types and constants
│   │   └── src/
│   │       ├── constants.ts      # CONTRACT_ADDRESSES, STELLAR_NETWORKS
│   │       ├── schemas.ts        # Zod request schemas
│   │       └── utils.ts          # Pure utility functions
│   │
│   └── contracts/                # Rust/Soroban smart contracts
│       └── vault/src/lib.rs      # MeridianVault contract
│
├── apps/landing/                 # Static landing page
├── scripts/                      # Build and deploy helpers
├── vercel.json                   # Vercel routing config
└── turbo.json                    # Turborepo task graph
```

## Key boundaries

| Boundary | Rule |
|---|---|
| `api/` serverless functions | No workspace package imports. All logic is self-contained or uses npm packages only. |
| `apps/api` Fastify server | Can import from `@meridian/shared` and `@meridian/stellar-sdk-helpers`. Used for local development. |
| `apps/web` | No direct Soroban SDK usage. All blockchain interaction goes through the API. |
| `packages/contracts` | Rust only. No TypeScript. |

## Task pipeline

```
build → depends on ^build (packages built before apps)
dev   → persistent, no cache
test  → depends on ^build
```

Run any task across all packages with `pnpm <task>` (e.g. `pnpm typecheck`, `pnpm test`). Run for a single package with `pnpm --filter @meridian/<package> <task>`.
