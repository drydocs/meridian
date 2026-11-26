# ADR-0004: Deployed contract code is immutable

- Status: Accepted

## Context

The vault and adapters govern deposited funds. An in-place code upgrade
authority would let a key holder change the rules applied to those funds after
deployment, increasing the consequences of compromised or misused authority.

## Decision

Vault and adapter contracts do not expose an upgrade entry point. Once
deployed, their code cannot be rewritten by Meridian or an administrator.

## Alternatives considered

- Add an admin-gated upgrade entry point. Rejected because it would compound
  the admin key's existing authority and undermine the guarantee that deployed
  code cannot be changed.
- Keep deployed code upgradeable only during a rollout period. Rejected
  because it would still require trusting an upgrade authority for live funds.

## Consequences

Code fixes and features require a new deployment and a coordinated cutover.
Adapter changes for a live vault use the vault's slippage-bounded migration
flow; a vault-level change requires a new vault deployment. This increases
deployment and migration work but removes upgrade-key risk.
