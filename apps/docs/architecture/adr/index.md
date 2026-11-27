# Architecture Decision Records

Architecture Decision Records (ADRs) capture decisions that shape Meridian's
architecture, why they were made, and the tradeoffs they create. These records
backfill established decisions as well as provide a place to document future
ones.

When a proposed change alters an accepted decision, update its ADR or add a new
record before implementing the change. Keep the index and relevant architecture
documentation in sync. See the [ADR template](./template.md).

## Accepted decisions

| ADR                                                | Decision                                  | Status   |
| -------------------------------------------------- | ----------------------------------------- | -------- |
| [0001](./0001-one-vault-per-asset.md)              | One vault deployment per supported asset  | Accepted |
| [0002](./0002-no-onchain-router.md)                | No separate on-chain router contract      | Accepted |
| [0003](./0003-custom-musdc-share-token.md)         | Use a custom SEP-41 mUSDC token           | Accepted |
| [0004](./0004-immutable-contracts.md)              | Deployed contract code is immutable       | Accepted |
| [0005](./0005-github-actions-keeper-scheduling.md) | Schedule keepers with GitHub Actions      | Accepted |
| [0006](./0006-migration-timelock.md)               | Use a roughly one-day migration timelock  | Accepted |
| [0007](./0007-admin-migration-slippage-cap.md)     | Cap migration slippage at 500 bps         | Accepted |
| [0008](./0008-upstash-keeper-state.md)             | Use Upstash Redis for shared keeper state | Accepted |
