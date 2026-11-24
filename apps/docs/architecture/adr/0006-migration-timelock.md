# ADR-0006: Use a roughly one-day migration timelock

- Status: Accepted

## Context

A candidate adapter's reported valuation could be manipulated briefly before
an immediate migration. A short wait also would not give depositors or
monitoring systems a meaningful opportunity to observe a proposed migration.

## Decision

Require at least 17,280 ledgers (approximately one day) between
`begin_migration` and `migrate_adapter` for the same target adapter. The
snapshot also supports the contract's valuation-stability check.

## Alternatives considered

- Migrate immediately after checking the candidate's value. Rejected because a
  transient valuation could pass at execution time.
- Keep the prior 12-ledger (approximately one-minute) delay. Rejected because
  it was too short to provide a practical observation window.

## Consequences

Observers and automated monitoring have time to detect and react before funds
move, and sustaining a valuation manipulation through the delay is harder. A
migration takes at least about a day, so the keeper must handle the pending
cooldown as a normal multi-run operation.
