# ADR-0007: Cap migration slippage at 500 bps

- Status: Accepted

## Context

Adapter migration can change the value reported for the vault's aggregate
position. An unbounded admin-supplied tolerance could authorize a migration
that loses an arbitrary portion of depositor value.

## Decision

Enforce a hard contract ceiling of 500 basis points (5%) on the
`max_slippage_bps` argument to `migrate_adapter`. The migration keeper uses a
lower default of 100 bps (1%).

## Alternatives considered

- Allow the caller to choose any value up to 10,000 bps. Rejected because this
  could permit a migration with up to 100% slippage.
- Use only a fixed keeper-side limit. Rejected because it would not constrain
  other authorized admin calls to the contract.

## Consequences

Every migration is bounded by an on-chain limit regardless of caller. A
legitimate migration requiring more than 5% tolerance must be resolved through
another operational path rather than relaxing the contract guard for that
call.
