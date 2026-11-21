# ADR-0001: One vault deployment per supported asset

- Status: Accepted

## Context

The vault represents a user's position in one deposit asset while underlying
protocols may change. Deploying a different vault for each protocol would split
that position and its share token across protocol choices.

## Decision

Deploy exactly one vault for each supported asset, rather than one vault per
protocol. Meridian currently supports USDC. The vault delegates protocol
operations to its active adapter; `migrate_adapter` moves the aggregate
position without changing depositor mUSDC balances.

## Alternatives considered

- Deploy a separate vault for each protocol. Rejected because protocol changes
  would fragment the asset's positions across vaults.
- Put several assets in one vault. Rejected in favor of a focused vault and
  share-token accounting for each supported asset.

## Consequences

Each asset has one share token and one aggregate position whose protocol
exposure can change through adapter migration. Adding another asset requires
another vault deployment and corresponding configuration; it does not require
another vault for each protocol.
