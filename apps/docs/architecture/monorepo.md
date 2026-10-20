# Monorepo Structure

Meridian is a pnpm workspace managed by Turborepo.

```
meridian/
├── api/                          # Vercel serverless functions (production API)
│   ├── _lib/
│   │   └── middleware.ts         # CORS + rate-limit helpers shared by handlers
│   └── v1/
│       ├── admin/                # GET /api/v1/admin/vault-state, GET /api/v1/admin/history
│       │   └── [resource].ts
│       ├── keepers/              # /api/v1/keepers/* (accrue, health, rebalance, alert)
│       │   └── [action].ts
│       ├── positions/            # GET /api/v1/positions/:publicKey, GET /api/v1/positions/:publicKey/history
│       │   ├── [publicKey]/
│       │   │   └── history.ts
│       │   └── [publicKey].ts
│       ├── tx/                   # POST /api/v1/tx/* (deposit, withdraw, add-trustline, submit)
│       │   └── [action].ts
│       └── vaults/               # GET /api/v1/vaults, GET /api/v1/vaults/:id
│           ├── index.ts
│           └── [vaultId].ts
│
├── apps/
│   ├── web/                      # Vite + React 19 dashboard
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
│   │       │   └── wallet.ts     # Wallet adapters (Freighter, LOBSTR, xBull) + picker
│   │       └── store/wallet.ts   # Zustand wallet state
│   │
│   ├── api-local/                # Fastify server (local development only)
│   │   └── src/
│   │       ├── index.ts
│   │       ├── routes/
│   │       │   ├── vaults.ts
│   │       │   ├── positions.ts
│   │       │   └── tx.ts
│   │       └── services/vaults.ts
│   │
│   ├── docs/                     # Documentation site (VitePress)
│   ├── landing/                  # Static landing page
│   └── strategies/               # Strategies simulation and visualization dashboard
│
├── packages/
│   ├── api-core/                 # Framework-agnostic route handlers shared by both servers
│   ├── sdk/                      # Public TypeScript SDK (@meridian/sdk)
│   ├── stellar-sdk-helpers/      # Stellar/Soroban client wrappers
│   │   └── src/
│   │       ├── tx.ts             # XDR builders (deposit, withdraw, submit)
│   │       ├── vaults.ts         # fetchAllVaults aggregator
│   │       ├── blend.ts          # Blend Capital helpers
│   │       ├── defindex.ts       # DeFindex helpers
│   │       ├── defilamma.ts      # DeFiLlama pool fetcher
│   │       ├── horizon.ts        # Horizon server helper
│   │       ├── internal.ts       # Shared internal utilities
│   │       ├── known-pools.ts    # Curated pool registry
│   │       ├── orchestration.ts  # Cross-protocol routing orchestration
│   │       ├── positions.ts      # On-chain position fetching
│   │       ├── routing.ts        # Best-rate routing logic
│   │       └── types.ts          # Shared TypeScript types
│   │
│   ├── shared/                   # Cross-package types and constants
│   │   └── src/
│   │       ├── constants.ts      # CONTRACT_ADDRESSES, STELLAR_NETWORKS
│   │       ├── schemas.ts        # Zod request schemas
│   │       └── utils.ts          # Pure utility functions
│   │
│   ├── strategies/               # Strategy simulation engine (@meridian/strategies)
│   │   └── src/
│   │       ├── decimal.ts        # Fixed-point Decimal math
│   │       ├── guard.ts          # Simulation boundary guard
│   │       ├── portfolio.ts      # Multi-asset portfolio tracking
│   │       ├── strategy.ts       # Strategy lifecycle and execution
│   │       └── types.ts          # Strategy parameters and metrics
│   │
│   └── contracts/                # Rust/Soroban smart contracts
│       ├── vault/src/lib.rs           # MeridianVault: protocol-agnostic coordinator
│       ├── blend-adapter/src/lib.rs   # Supplies USDC into a Blend lending pool
│       ├── defindex-adapter/src/lib.rs # Deposits USDC into a DeFindex vault
│       ├── adapter-common/src/lib.rs  # Common traits and types for adapters
│       └── musdc-token/src/lib.rs     # mUSDC yield-bearing share token
├── scripts/                      # Deployment (testnet/mainnet, external pinger), adapter redeploy, verifier, build, and load tests
├── vercel.json                   # Vercel routing config
└── turbo.json                    # Turborepo task graph
```

## Key boundaries

| Boundary                        | Rule                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/` serverless functions     | Imports from `@meridian/shared` and `@meridian/stellar-sdk-helpers` via pre-built `dist/` bundles. `scripts/build-vercel.sh` runs esbuild on each package before the Vercel build so the handlers can import compiled JS rather than TypeScript source. |
| `apps/api-local` Fastify server | Imports the same workspace packages directly via `tsx` (TypeScript-native). Used for local development only.                                                                                                                                            |
| `apps/web`                      | No direct Soroban SDK usage. All blockchain interaction goes through the API.                                                                                                                                                                           |
| `packages/contracts`            | Rust only. No TypeScript.                                                                                                                                                                                                                               |

## Task pipeline

```
build → depends on ^build (packages built before apps)
dev   → persistent, no cache
test  → depends on ^build
```

Run any task across all packages with `pnpm <task>` (e.g. `pnpm typecheck`, `pnpm test`). Run for a single package with `pnpm --filter @meridian/<package> <task>`.
