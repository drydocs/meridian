# ADR-0008: Use Upstash Redis for shared keeper state

- Status: Accepted

## Context

Keeper invocations run in stateless serverless functions. Cross-invocation
deduplication and migration rate history need a shared store; process-local
memory cannot reliably coordinate requests across separate instances.

## Decision

Use Upstash Redis through its HTTP REST API for production keeper state,
including submission leases and migration rate snapshots. Reuse the configured
Upstash credentials already used by the API.

## Alternatives considered

- Keep state only in process memory. Rejected for production because separate
  invocations would not share deduplication or rate history.
- Operate a self-hosted Redis service. Rejected because it adds infrastructure
  to provision and maintain.
- Use a different managed key-value service. Not selected; Upstash's REST
  interface and existing project configuration meet the current needs.

## Consequences

The migration keeper depends on the shared store being configured in deployed
environments and fails closed without it. The accrual keeper can fall back to
per-invocation state, but that weakens duplicate-submission protection.
