# Treasury Operations and Fee Accounting

The vault charges a constructor-fixed 10% performance fee on positive gain
above the withdrawing holder's proportional principal. The fee remains
invested in the vault, and equivalent mUSDC shares are minted to the
constructor-fixed treasury address. The address cannot be changed in place;
changing it requires a fresh vault deployment and a coordinated cutover.
See [Vault Contract](../architecture/vault-contract.md) for the fee
calculation and event schema.

## Treasury custody and approvals

The **Treasury Operations owner** is accountable for custody, daily
monitoring, and maintaining the reconciliation. The **Finance reviewer**
independently reviews the selected address before deployment and approves
each redemption and month-end reconciliation. Assign named people to these
roles in the deployment record; do not leave either role implicit. The
vault admin/deployment operator verifies the on-chain address but does not
replace Finance approval.

Use an organization-controlled, durable treasury address with custody
appropriate to the funds and an independent recovery process. For mainnet,
prefer a reviewed multisig or hardware-backed custody arrangement; do not
use a disposable deployer key or a shared personal key. Keep the treasury
signing authority separate from the vault admin where practical. The
treasury address is public, but its signing material is secret and must
never be committed or included in a deployment manifest.

Before deploying, the Treasury Operations owner records the network,
vault, proposed treasury address, custody/signers, owner, and Finance
reviewer. Both owner and reviewer verify the address from an independent
source, confirm it is controlled and able to sign/submit mUSDC withdrawals,
and compare it character-for-character with `TREASURY`. After deployment,
independently read `get_treasury` and confirm it matches the approved
address. Retain the approval and result with the deployment record.

## Monitoring and reporting cadence

- **Each business day:** Treasury Operations checks the current on-chain
  mUSDC balance, scans new vault `perf_fee` events, and records unexpected
  transfers or withdrawals. Investigate missing, duplicate, or
  wrong-recipient events the same day.
- **At month end:** reconcile every `perf_fee` event and treasury share
  movement for the period, agree the closing mUSDC balance to the token
  contract, and have the Finance reviewer sign off. Record both raw
  stroops and human-readable token amounts.
- **Immediately:** escalate an unexpected treasury address, unexplained
  balance movement, suspected signing-key compromise, failed redemption,
  or disagreement that cannot be resolved from on-chain records. Preserve
  the ledger range, transaction hashes, event data, and balance snapshots.

The existing alert keeper does not monitor `perf_fee` events or treasury
balances. Until a dedicated monitor is deployed, the Treasury Operations
owner must perform the daily checks manually using a Stellar explorer or
RPC event history. Filter for the vault contract address and the
`perf_fee` event topic `(perf_fee, u32(1))`. The event data is
`(caller, treasury, fee, treasury_shares)`; verify the treasury field on
every event.

## Reconciliation worksheet

Use one row per `perf_fee` event, keyed by ledger, transaction hash, and
event index. The `fee` is USDC stroops and `treasury_shares` is mUSDC
stroops. Both tokens use 7 decimals. Preserve the integer values as
authoritative; do not round before comparing.

| Ledger | Transaction hash / event index | Caller | Treasury | Fee (USDC stroops) | Treasury shares minted (mUSDC stroops) | Included in period? | Notes |
| ------ | ------------------------------ | ------ | -------- | ------------------ | -------------------------------------- | ------------------- | ----- |
|        |                                |        |          |                    |                                        |                     |       |

At period end, use the following movement check:

```text
closing mUSDC balance
= opening mUSDC balance
+ sum(treasury_shares from perf_fee events in the period)
+ mUSDC transfers in
- mUSDC transfers out
- shares burned by treasury withdrawals
```

Read the opening and closing values from the mUSDC contract's `balance`
entry point for the approved treasury address. Include all token transfers
and withdrawals in the period, including a redemption that itself emits a
new `perf_fee` event. Explain every adjustment and investigate any
difference; the event sum alone is not expected to equal the ending
balance after redemptions or transfers.

Use the `fee` event amount as the on-chain USDC fee record and
`treasury_shares` as the mUSDC issuance record. The shares' USDC value can
change with vault performance. Apply the organization's approved accounting
policy to recognize revenue and realized USDC proceeds, and avoid counting
the same fee once at issuance and again at redemption.

## Redeeming treasury shares

Treasury mUSDC is redeemed through the vault's normal
`withdraw(caller, shares, min_usdc_out)` entry point. The treasury must
authorize the call. The `preview_withdraw(holder, shares)` view returns
gross assets, fee, treasury shares minted, and net assets out; use it
immediately before submitting the withdrawal and set a nonzero
`min_usdc_out` appropriate to the approved slippage tolerance.

Fee-minted shares do not carry a depositor principal record. A withdrawal
of those shares therefore treats the redeemed amount as gain for fee
calculation; the normal 10% fee can apply again, with new shares minted
back to the same treasury. Expect redemption proceeds to be net of this
fee and include the new fee event and shares in the reconciliation.

### Testnet redemption dry run

Use a testnet treasury key/address and a vault with a positive treasury
balance. Testnet deployments may default `TREASURY` to `ADMIN`; set it
explicitly for this exercise so the custody and invocation steps are
tested. Do not use a mainnet key or transaction.

1. Set `VAULT_CONTRACT_ID`, `MUSDC_CONTRACT_ID`, `USDC_ID`,
   `TREASURY_ADDRESS`, and `TREASURY_KEY` for the testnet deployment.
   Verify the configured treasury:

   ```sh
   stellar contract invoke --network testnet --source "$TREASURY_KEY" \
     --id "$VAULT_CONTRACT_ID" -- get_treasury
   ```

   Stop if the returned address differs from `TREASURY_ADDRESS`. The
   treasury address is immutable on this vault.

2. Read and record the treasury mUSDC balance:

   ```sh
   stellar contract invoke --network testnet --source "$TREASURY_KEY" \
     --id "$MUSDC_CONTRACT_ID" -- balance --id "$TREASURY_ADDRESS"
   ```

   Choose a small positive `SHARES` amount in raw mUSDC stroops no greater
   than this balance. Do not redeem the full balance on the first test.
   Also record the starting USDC balance:

   ```sh
   stellar contract invoke --network testnet --source "$TREASURY_KEY" \
     --id "$USDC_ID" -- balance --id "$TREASURY_ADDRESS"
   ```

3. Simulate the redemption and record `gross_assets`, `fee`,
   `treasury_shares`, and `assets_out`:

   ```sh
   stellar contract invoke --network testnet --source "$TREASURY_KEY" \
     --id "$VAULT_CONTRACT_ID" -- preview_withdraw \
     --holder "$TREASURY_ADDRESS" --shares "$SHARES"
   ```

   Confirm the quote is positive and has the expected fee behavior. Select
   a nonzero `MIN_USDC_OUT` in raw USDC stroops below the quoted
   `assets_out` by the test's approved tolerance. If the quote or tolerance
   is unclear, stop rather than submitting.

4. With the Treasury Operations owner and Finance reviewer both approving
   the quote, submit the withdrawal:

   ```sh
   stellar contract invoke --network testnet --source "$TREASURY_KEY" \
     --id "$VAULT_CONTRACT_ID" -- withdraw --caller "$TREASURY_ADDRESS" \
     --shares "$SHARES" --min-usdc-out "$MIN_USDC_OUT"
   ```

5. Read the treasury's mUSDC balance again and confirm the share change
   against the burned `SHARES` and any `treasury_shares` minted in the
   transaction's `perf_fee` event. Read the USDC balance again and compare
   its increase with the transaction result and preview, accounting for
   adapter rounding. Record the transaction hash and event in the worksheet
   and obtain Finance sign-off.

## Emergency handling

For an unexpected fee recipient or balance movement, stop treasury
redemptions, preserve the affected ledger and transaction data, and notify
the Treasury Operations owner, Finance reviewer, and vault admin through
the incident channel. If a treasury signing key may be compromised, do
not submit further treasury transactions until the incident response
owner has assessed custody and signer state. Follow
[Incident Response](./incident-response.md) for suspected admin compromise
or pausing deposits.

Pausing deposits does not block withdrawals or stop fees on withdrawals.
The treasury address itself has no setter, and transferring the vault admin
does not change it. If the address must change, prepare a new vault
deployment and coordinated cutover under
[Mainnet Deployment](./mainnet-deployment.md); do not promise an in-place
rotation. Whether existing treasury shares can be safely moved or redeemed
must be assessed as part of the incident, with Finance approval.
