# ADR-0003: Use a custom SEP-41 mUSDC token

- Status: Accepted

## Context

mUSDC represents vault shares and is freely transferable. The vault also
tracks cost basis and entry time so transfers can carry the corresponding
accounting to the recipient.

## Decision

Use a custom SEP-41 token contract for mUSDC, not a Stellar Asset Contract
(SAC). The token calls the vault's `on_transfer` hook after moving balances,
allowing the vault to split principal and entry-time accounting pro rata.

The token's `total_supply` is also the source of truth for vault share pricing
and totals. Holder burns bypass vault withdrawals, so `TOTAL_SH` is retained as
a diagnostic cache, not an authority. Admin resync reads the token instead of
accepting a replacement value. See [supply recovery](../../operations/musdc-supply-recovery.md)
for reconciliation and immutable-deployment cutover limits.

## Alternatives considered

- Use a SAC for mUSDC. Rejected because its built-in transfer behavior cannot
  invoke the vault's accounting callback.
- Make shares non-transferable or track ownership separately from the token.
  Rejected in favor of transferable shares whose live token balances remain the
  source of ownership.

## Consequences

mUSDC requires a separate contract deployment, and the vault must be configured
as its administrator so deposits and withdrawals can mint and burn shares.
Transfer accounting adds a contract interaction, but share transfers preserve
the vault's cost-basis and entry-time records.
