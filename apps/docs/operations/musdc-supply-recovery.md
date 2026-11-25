# Recovering mUSDC supply drift

Holder-initiated `burn` and allowance-authorized `burn_from` destroy mUSDC
without redeeming USDC. The assets remain at the adapter. Older vault code
continues to count those shares in `TOTAL_SH`, which distorts pricing and can
prevent an otherwise empty adapter swap.

## Vaults deployed with live-supply accounting

Pricing, previews, `get_total_shares`, and `get_config().total_shares` read the
configured mUSDC token's `total_supply`. A failed supply read aborts these calls;
it never silently falls back to the cached counter. Tokens without this method
are not supported for pricing by this vault version.

`get_health().total_shares` deliberately retains the cached counter for diagnosis.
Compare it with `musdc_supply`, checking `musdc_supply_stale` first. A mismatch
after a direct burn does not mean pricing is stale. Successful deposits and
withdrawals also reconcile the counter using live supply.

The vault admin can invoke `sync_total_shares()` to repair the cache immediately.
It takes no replacement value, reads the configured token, uses the vault's
reentrancy lock, and emits `(admin, sync_sh, 1)` with `(previous, actual)` supply.
It neither moves assets nor changes holder balances, principal, or entry time.
An unauthorized call or failed token read leaves the cache unchanged.

After reconciliation, verify health again. Do not clear `ADPT_SH` to make an
adapter swap succeed: even a one-stroop burn leaves real assets behind.
`set_adapter` still rejects a residual adapter position. Use the existing
admin-authorized `begin_migration` / timelock / `migrate_adapter` flow to move that
position, including when live mUSDC supply is zero. See the
[adapter migration procedure](./testnet-deployment.md).

## Existing immutable deployments

This source change cannot add a resync entry point to an already-deployed vault.
Neither the token nor the vault exposes a code upgrade mechanism. Changing an
adapter does not replace the vault or repair its cached share count.

For an affected deployment:

1. Record the network, contract addresses, ledger, token supply, cached vault
   shares, adapter shares/assets, and affected holder balances. Use `get_health`
   only if that deployed version exposes it; otherwise read the individual views.
2. Pause new deposits and retain access to the old vault's withdrawal interface.
   Simulate withdrawals against that exact deployed code. Historical drift can
   underpay a withdrawal; do not promise full recovery from a normal withdrawal.
3. Deploy the fixed vault with a new mUSDC token and correctly bound adapter,
   following the [vault cutover procedure](./mainnet-deployment.md#rollback-plan).
   Verify live supply and burn/deposit/withdraw behavior on testnet first.
4. Keep old balances and any stranded assets in the incident inventory. Moving
   remaining holders requires their authorization; changing application addresses
   does not move funds. There is no generic in-place repair or automatic recovery
   of the stranded value in the old ABI. Resolve that incident separately before
   declaring the old deployment recovered.

The resync method applies only to deployments containing this change. This
preserves the [immutable-contract decision](../architecture/adr/0004-immutable-contracts.md).
