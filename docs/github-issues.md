# Meridian — GitHub Issues for Wave Contributors

Copy each block below into a GitHub issue. Label each with its difficulty tag.

---

## Issue #1 — [Trivial] Mobile-responsive layout pass

**Labels:** `good-first-issue` `frontend` `trivial`

**Description**

The dashboard currently uses a desktop-first layout. Many of our target users (West Africa) access the web on mobile. This issue tracks making the main dashboard responsive.

**Tasks**
- [ ] Ensure `VaultList` cards stack vertically on screens < 640px
- [ ] Make the header nav collapse or simplify on mobile
- [ ] Verify `PortfolioSummary` numbers are readable at 375px width
- [ ] Test in Chrome DevTools mobile emulator (iPhone SE, Pixel 5)

**Files to change**
- `apps/web/src/components/dashboard/VaultList.tsx`
- `apps/web/src/components/dashboard/PortfolioSummary.tsx`
- `apps/web/src/pages/index.tsx`

**Acceptance criteria**
- No horizontal scroll on 375px viewport
- All numeric values legible without zooming

---

## Issue #2 — [Trivial] Wire up Freighter wallet adapter

**Labels:** `good-first-issue` `frontend` `stellar` `trivial`

**Description**

The `WalletConnect` component currently calls `connect("PLACEHOLDER_PUBLIC_KEY")`. This issue replaces the placeholder with a real [Freighter](https://freighter.app) integration using `@stellar/freighter-api`.

**Tasks**
- [ ] `pnpm add @stellar/freighter-api` in `apps/web`
- [ ] Detect whether Freighter is installed; show install prompt if not
- [ ] Call `getPublicKey()` from Freighter and pass it to `useWalletStore().connect()`
- [ ] Handle user rejection gracefully (show toast or inline error)
- [ ] Export a `signTransaction(xdr: string)` helper from `apps/web/src/lib/wallet.ts`

**Files to change**
- `apps/web/src/components/onboarding/WalletConnect.tsx`
- `apps/web/src/lib/wallet.ts` *(create)*

**Acceptance criteria**
- Clicking "Connect Wallet" opens Freighter extension
- `useWalletStore().publicKey` holds the real G... address after connection
- Disconnecting clears the store

---

## Issue #3 — [Trivial] Vault card UI component

**Labels:** `good-first-issue` `frontend` `ui` `trivial`

**Description**

`VaultList` renders a loading placeholder. This issue adds a `VaultCard` presentational component and wires it to static mock data so contributors can build the UI independently of the live API.

**Tasks**
- [ ] Create `apps/web/src/components/dashboard/VaultCard.tsx`
- [ ] Props: `{ name, protocol, apy, tvl, asset, onDeposit }`
- [ ] Display APY prominently (large number), protocol badge (Blend / DeFindex), TVL, and a "Deposit" CTA button
- [ ] Add 2–3 mock vaults to `VaultList` using the new component
- [ ] Style with Tailwind; dark theme consistent with existing palette

**Acceptance criteria**
- `VaultCard` renders without errors with mock props
- Storybook story or screenshot in PR description

---

## Issue #4 — [Medium] Blend pool APY + TVL fetcher

**Labels:** `medium` `stellar` `protocol-integration`

**Description**

`packages/stellar-sdk-helpers/src/blend.ts` exports stubs that throw `Not implemented`. This issue implements `getBlendPoolInfo()` by reading on-chain pool data from the Blend lending protocol on Stellar testnet.

**Context**

Blend stores pool state in Soroban contract storage. The relevant entry keys are documented at https://docs.blend.capital/tech-docs/core-contracts/lending-pool/pool-state. Use the Soroban RPC `getLedgerEntries` method via `@stellar/stellar-sdk`'s `rpc.Server`.

**Tasks**
- [ ] Decode Blend pool reserve data for a given asset (USDC testnet)
- [ ] Calculate supply APY from `ir_params` and utilization rate
- [ ] Calculate TVL from total supplied balance
- [ ] Return `{ apy: number, tvl: bigint }` matching the `VaultInfo` shape
- [ ] Unit test with a recorded RPC fixture (no live network in CI)

**Files to change**
- `packages/stellar-sdk-helpers/src/blend.ts`

**Acceptance criteria**
- `getBlendPoolInfo()` returns non-zero APY and TVL for the USDC testnet pool
- Unit test passes in CI without network access

---

## Issue #5 — [Medium] DeFindex vault APY + TVL fetcher

**Labels:** `medium` `stellar` `protocol-integration`

**Description**

`packages/stellar-sdk-helpers/src/defindex.ts` exports stubs that throw `Not implemented`. This issue implements `getDefindexVaultInfo()` by querying DeFindex vault contracts.

**Context**

DeFindex vaults expose a `get_vault_info` contract function that returns total assets and total shares. APY must be estimated from the share-price delta over time (fetch current and 24h-ago share prices via event history or a stored checkpoint). DeFindex docs: https://docs.defindex.io

**Tasks**
- [ ] Call `get_vault_info` on the DeFindex factory contract (testnet)
- [ ] Derive TVL from `total_assets`
- [ ] Estimate 24h APY from share price delta (use fallback of 0 if no history available)
- [ ] Unit test with recorded RPC fixture

**Files to change**
- `packages/stellar-sdk-helpers/src/defindex.ts`

**Acceptance criteria**
- `getDefindexVaultInfo()` returns TVL for at least one testnet vault
- APY returns 0 gracefully when share price history is absent

---

## Issue #6 — [Medium] APY aggregation API endpoint

**Labels:** `medium` `backend` `api`

**Description**

`GET /api/v1/vaults` currently returns an empty array. This issue implements the aggregation layer: fetch APY + TVL from Blend (#4) and DeFindex (#5), merge into a unified `VaultInfo[]` response, and cache results in Redis for 60 seconds to avoid hammering RPC nodes.

**Tasks**
- [ ] Create `apps/api/src/services/vaultAggregator.ts`
- [ ] Call `getBlendPoolInfo` and `getDefindexVaultInfo` in parallel (`Promise.all`)
- [ ] Map results to the shared `VaultInfo` schema
- [ ] Cache aggregated result in Redis with 60s TTL; serve from cache on subsequent calls
- [ ] Return `{ vaults: VaultInfo[], updatedAt: string, cached: boolean }`
- [ ] Add integration test with Redis mock

**Files to change / create**
- `apps/api/src/services/vaultAggregator.ts`
- `apps/api/src/routes/vaults.ts`

**Acceptance criteria**
- `GET /api/v1/vaults` returns at least one vault with non-zero APY on testnet
- Second request within 60s returns `cached: true`

---

## Issue #7 — [Medium] Unsigned Soroban deposit transaction builder

**Labels:** `medium` `backend` `stellar` `soroban`

**Description**

`POST /api/v1/tx/deposit` returns 501. This issue implements the transaction builder: given a wallet address, vault ID, and amount, return a base64-encoded unsigned XDR transaction ready for the frontend to pass to Freighter for signing.

**Context**

The API must never hold private keys. Build the transaction using `TransactionBuilder` + `Operation.invokeHostFunction`, simulate it via `rpc.Server.simulateTransaction` to get the resource footprint, and return the XDR string. The frontend signs with Freighter and submits.

**Tasks**
- [ ] Resolve vault ID to protocol (Blend or DeFindex) and contract address
- [ ] Build a Soroban `invokeHostFunction` operation calling `deposit(depositor, amount)`
- [ ] Simulate the transaction to populate the resource fee
- [ ] Return `{ xdr: string, fee: string }` from the endpoint
- [ ] Implement the same for `POST /api/v1/tx/withdraw`
- [ ] Integration test against Stellar testnet (skip in offline CI with env flag)

**Files to change**
- `apps/api/src/routes/tx.ts`
- `packages/stellar-sdk-helpers/src/blend.ts` (implement `buildBlendDepositTx`)
- `packages/stellar-sdk-helpers/src/defindex.ts` (implement `buildDefindexDepositTx`)

**Acceptance criteria**
- Returned XDR can be decoded and submitted after Freighter signing on testnet
- Invalid wallet address / amount returns 400 with a clear error

---

## Issue #8 — [Hard] Soroban router contract for single-transaction rebalancing

**Labels:** `hard` `soroban` `rust` `contracts`

**Description**

Currently a user must send separate transactions to withdraw from one vault and deposit into another. This issue implements a Soroban smart contract (`meridian-router`) that executes both legs atomically in one transaction.

**Context**

Stellar's Soroban supports cross-contract calls within a single transaction. The router contract should:
1. Accept `(from_vault, to_vault, amount, min_out)` as arguments
2. Call `withdraw(amount)` on `from_vault`
3. Call `deposit(received)` on `to_vault`
4. Revert the entire transaction if `received < min_out` (slippage guard)

**Tasks**
- [ ] Create `packages/contracts/src/router.rs` with the `rebalance` entry point
- [ ] Add Soroban authorization checks (`require_auth` for the depositor)
- [ ] Write unit tests in Rust using `soroban-sdk::testutils`
- [ ] Integration test against testnet using mock Blend/DeFindex stubs
- [ ] Update `scripts/deploy-testnet.sh` to deploy the router contract
- [ ] Document the contract interface in `docs/contracts.md`

**Acceptance criteria**
- `cargo test` passes for the router contract
- A single Freighter transaction moves funds between two vaults on testnet
- Slippage guard reverts correctly in the test suite

---

## Issue #9 — [Medium] Yield history sparkline chart

**Labels:** `medium` `frontend` `data-viz`

**Description**

Add a small APY history sparkline to each `VaultCard` so users can see whether yields are trending up or down. This makes the dashboard feel alive and helps users make informed deposit decisions.

**Tasks**
- [ ] Create a `GET /api/v1/vaults/:id/history?days=7` endpoint
- [ ] Store APY snapshots in Redis sorted set (`ZADD` by timestamp) each time the aggregator refreshes
- [ ] Return `{ points: { timestamp: number, apy: number }[] }`
- [ ] Add a `<SparklineChart />` component using `recharts` `<LineChart>`
- [ ] Render the sparkline inside `VaultCard` below the current APY

**Acceptance criteria**
- Chart renders with ≥ 2 data points without crashing
- Gracefully shows "No history yet" if fewer than 2 points are available

---

## Issue #10 — [Hard] French / English i18n with locale detection

**Labels:** `hard` `frontend` `i18n` `accessibility`

**Description**

Meridian targets West Africa — a region with both English (Nigeria, Ghana) and French (Senegal, Côte d'Ivoire) speaking users. This issue adds internationalization using `next-intl` and provides a complete French translation of the UI.

**Context**

French translation quality matters for trust. Prefer human review of financial terminology (e.g., "rendement annuel" for APY, "solde" for balance) over raw machine translation.

**Tasks**
- [ ] `pnpm add next-intl` in `apps/web`
- [ ] Set up `next-intl` middleware with locale detection (`accept-language` header, fallback `en`)
- [ ] Create `apps/web/messages/en.json` and `apps/web/messages/fr.json`
- [ ] Replace all hardcoded UI strings with `useTranslations()` calls
- [ ] Add a language toggle (EN / FR) to the header
- [ ] Verify number/currency formatting respects locale (e.g., `12.5%` vs `12,5 %`)
- [ ] Add Playwright test asserting French strings render on `?locale=fr`

**Acceptance criteria**
- All user-facing strings translated in both locales
- No English strings visible when `locale=fr`
- Language toggle persists selection to `localStorage`
