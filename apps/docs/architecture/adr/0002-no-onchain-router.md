# ADR-0002: No separate on-chain router contract

- Status: Accepted

## Context

Meridian needs to direct USDC into supported yield protocols and move an
existing position when protocol exposure changes. The vault already coordinates
deposits and withdrawals, and protocol-specific behavior belongs in adapters.

## Decision

Do not deploy a separate `MeridianRouter` contract. The vault's active adapter
determines where deposits go; `migrate_adapter` handles changes to the vault's
aggregate protocol exposure. Rate discovery and keeper candidate selection
remain off-chain.

## Alternatives considered

- Use a separate router contract with its own vault registry and routing
  controls. Rejected because it duplicated coordination already provided by
  the vault and introduced another on-chain authorization boundary.
- Add protocol selection to each `deposit` call. Rejected because the
  protocol-specific choice is held by the vault's adapter, not by each user
  transaction.

## Consequences

The contract model has fewer moving parts, and each asset's position remains
in one vault while its adapter changes. There is no router-level vault
allowlist: admin authority and the keeper's configured adapter candidates
bound migration targets. Off-chain rate selection is not itself an on-chain
guarantee.
