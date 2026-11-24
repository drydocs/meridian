# Wallet Signing & Connection Troubleshooting

This guide is a diagnostic runbook for wallet connection and transaction signing failures across Meridian on both **Stellar testnet** and **mainnet**.

Because Meridian is strictly non-custodial, the API constructs unsigned Soroban transactions (XDR) and delegates signing to your connected wallet adapter via the `WalletAdapter` interface. Most transaction failures occur before reaching the ledger—during extension detection, wallet authorization, signature prompting, simulation, or submission checks.

---

## Supported Wallets

Meridian connects to wallets using adapter wrappers located in `apps/web/src/lib/wallet.ts`:

| Wallet        | Adapter Status                                     | Detection Method                                   | Official Website                       |
| ------------- | -------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| **Freighter** | Supported & wired in wallet picker                 | `@stellar/freighter-api` (`isConnected()`)         | [freighter.app](https://freighter.app) |
| **LOBSTR**    | Supported & wired in wallet picker                 | `@lobstrco/signer-extension-api` (`isConnected()`) | [lobstr.co](https://lobstr.co)         |
| **xBull**     | Supported & wired in wallet picker                 | `window.xBullSDK`                                  | [xbull.app](https://xbull.app)         |
| **Albedo**    | Adapter implemented & tested; not yet in picker UI | Web popup bridge (`albedo.link`)                   | [albedo.link](https://albedo.link)     |

> [!NOTE]
> Hardware wallets (e.g., Ledger) can be used indirectly through Freighter or xBull if your hardware wallet account is connected inside the extension.

---

## Quick Diagnostic Checklist

When a transaction fails or a wallet will not connect, check the following first:

1. **Extension unlocked**: Is your wallet unlocked and displaying the expected Stellar public key?
2. **Matching network**: Is your wallet set to the exact network Meridian is running against (Testnet vs Mainnet)?
3. **XLM reserve**: Does your account hold enough native XLM to meet Stellar's base reserve (1 XLM minimum + 0.5 XLM per trustline) plus fees?
4. **Trustlines established**: Does your account have active trustlines for USDC (and mUSDC)?
5. **Explorer status**: Did the transaction submit or fail on-chain? Search your address on [Stellar Expert (Mainnet)](https://stellar.expert/explorer/public) or [Stellar Expert (Testnet)](https://stellar.expert/explorer/testnet).

---

## Failure Classes

### 1. Wallet Not Detected

The web application cannot locate the browser extension for your selected wallet.

- **Symptom**:
  - The wallet connect prompt shows an "Install Freighter" / "Install LOBSTR" / "Install xBull" button instead of connecting.
  - The header wallet dropdown displays an "Install" pill next to the wallet name.
- **Likely Cause**:
  - The wallet extension is not installed in the current browser.
  - The extension is disabled or blocked from running in private/incognito windows.
  - The page loaded before the extension's content script finished injecting into the window (`window.xBullSDK` or extension APIs were not ready).
  - You are using an unsupported mobile browser without extension support.
- **Next Action**:
  1. Install the extension from the official site ([Freighter](https://freighter.app), [LOBSTR](https://lobstr.co), or [xBull](https://xbull.app)).
  2. If using incognito/private mode, open your browser extension settings and enable "Allow in Incognito".
  3. Reload the page (press `Ctrl+F5` or `Cmd+Shift+R`) to re-trigger extension detection.
  4. If using mobile, access Meridian using a desktop browser or a mobile browser that supports Stellar extension signers.

---

### 2. Locked Wallet

The extension is installed, but the wallet is locked or site permissions have not been granted.

- **Symptom**:
  - Clicking "Connect Wallet" spins indefinitely or does nothing.
  - An error toast appears: `"Wallet Disconnected"`.
  - Console logs show permission denials or unhandled authorization errors.
- **Likely Cause**:
  - The extension auto-locked after a period of inactivity.
  - The user has not entered their extension master password/PIN to unlock account keys.
  - The site authorization request was dismissed, or permission for `usemeridian.vercel.app` (or `localhost`) was revoked in the extension settings.
- **Next Action**:
  1. Click your wallet icon in the browser toolbar.
  2. Enter your password or PIN to unlock the wallet.
  3. Verify that your desired Stellar account is selected.
  4. Return to Meridian and click "Connect Wallet" again.
  5. If prompted, approve the site connection request.

---

### 3. Rejected Signature

The transaction was constructed and simulated successfully, but the signature prompt was declined or closed.

- **Symptom**:
  - An error toast displays `"Signing cancelled"` or `"Action request was rejected by the user."`.
  - The transaction is not broadcast to Stellar RPC.
  - Account balances and vault shares remain unchanged.
- **Likely Cause**:
  - The user clicked "Reject", "Cancel", or "Deny" in the wallet signing dialog.
  - The popup window was closed before clicking "Sign" or "Approve".
  - The signing request timed out in the wallet extension.
- **Next Action**:
  1. This is a non-fatal, safe outcome: no funds moved and no gas was consumed.
  2. Click "Deposit" or "Withdraw" to rebuild a fresh transaction envelope.
  3. Review the contract address, function (`deposit` or `withdraw`), and amount in the wallet popup.
  4. Click "Approve" / "Sign" in the wallet prompt to proceed.

---

### 4. Wrong Network

The wallet is configured for a different Stellar network than the Meridian application.

- **Symptom**:
  - Submission fails with: `"Transaction rejected at submission: txBadAuth"`.
  - Error toast displays: `"Failed to submit transaction"`.
  - The wallet prompts a network mismatch warning (e.g., Freighter warns that the transaction was prepared for a different network).
- **Likely Cause**:
  - The transaction envelope is signed against a specific network passphrase:
    - **Testnet**: `"Test SDF Network ; September 2015"`
    - **Mainnet**: `"Public Global Stellar Network ; September 2015"`
  - If Meridian is running against Testnet while your wallet is toggled to Public/Mainnet (or vice versa), the cryptographic signature will not match the network transaction hash, causing RPC submission to reject with `txBadAuth`.
- **Next Action**:
  1. Open your wallet extension settings.
  2. Switch the active network:
     - For production Meridian: Select **Public Global Stellar Network** (Mainnet).
     - For local or staging Meridian: Select **Test SDF Network** (Testnet).
  3. Refresh the Meridian page and initiate the transaction again.

---

### 5. Missing USDC or mUSDC Trustline

Your Stellar account does not have the required trustline to hold USDC or vault share tokens (mUSDC).

- **Symptom**:
  - Error toast displays: `"Missing USDC trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing."` or `"Failed to add vault assets"`.
  - API returns HTTP 400 with `{ "error": "Missing USDC trustline..." }` or `{ "error": "Missing required trustlines: USDC, MUSDC..." }`.
- **Likely Cause**:
  - Stellar accounts require explicit trustlines for non-native assets before receiving them.
  - Deposits require trustlines for both **USDC** (the deposited token) and **mUSDC** (the vault share token minted to your account).
  - Meridian checks trustlines before building transactions via `assertRequiredTrustlines`. If missing, the app triggers an automatic `add-trustline` transaction. If that transaction was rejected or failed, the deposit cannot proceed.
- **Next Action**:
  1. Allow the app to establish trustlines when prompted (you will see a signing request for adding the asset trustlines).
  2. Alternatively, add the USDC trustline directly inside your wallet extension:
     - **Mainnet USDC Issuer**: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Circle)
     - **Testnet USDC Issuer**: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
  3. Ensure your account holds at least **1.5–2 XLM** to cover the 0.5 XLM minimum reserve requirement per trustline.
  4. Contributors can build and inspect the trustline transaction using curl:

     ```bash
     curl -s -X POST http://localhost:3001/api/v1/tx/add-trustline \
       -H "Content-Type: application/json" \
       -d '{"walletAddress":"<YOUR_PUBLIC_KEY>"}'
     ```

---

### 6. Insufficient XLM for Fees & Reserves

The account lacks enough native XLM to pay network resource fees or satisfy the Stellar base reserve.

- **Symptom**:
  - Error toast displays: `"Transaction rejected at submission: txInsufficientBalance"` or `"Transaction rejected at submission: txInsufficientFee"`.
  - Wallet extension warns: `"Insufficient balance for transaction fee"`.
- **Likely Cause**:
  - Stellar accounts require a base reserve of **1.0 XLM** plus **0.5 XLM** for each entry (trustlines, signers, data entries).
  - In addition, Soroban transactions require resource and inclusion fees (stroops) paid in native XLM.
  - If your available (unreserved) XLM balance is below the fee threshold, the transaction cannot be submitted to the mempool.
- **Next Action**:
  - **On Testnet**:
    - Fund your account via Stellar Friendbot:

      ```bash
      curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
      ```

    - Or use Meridian's built-in testnet faucet integration on testnet builds.
  - **On Mainnet**:
    - Transfer 2–5 XLM to your public key from an exchange or another wallet.
    - Check your spendable balance vs. reserved balance using Horizon:

      ```bash
      curl -s "https://horizon.stellar.org/accounts/<YOUR_PUBLIC_KEY>" | jq .balances
      ```

---

### 7. Simulation Failure

The Soroban transaction simulation failed on the RPC node during transaction building.

- **Symptom**:
  - Error toast displays:
    - `"Slippage tolerance exceeded. Adjust slippage and retry."` (Contract error `#18` or `#15`)
    - `"Deposits are currently paused. Try again later."` (Contract error `#3`)
    - `"Insufficient shares for this withdrawal."` (Contract error `#7`)
    - `"Couldn't read the current vault price. Please try again."`
    - `"Failed to build deposit transaction"` (generic fallback HTTP 500)
- **Likely Cause**:
  - **Slippage mismatch**: Rapid yield accrual, rebalancing, or deposits changed the vault ratio between the time the quote was generated and when simulation ran.
  - **Contract paused**: The vault coordinator was temporarily paused by the admin (`set_paused`).
  - **Share balance mismatch**: You attempted to withdraw more shares than your on-chain balance currently holds.
  - **RPC node issue**: The Soroban RPC node timed out or encountered an internal simulation error.
- **Next Action**:
  1. For slippage errors: Wait a few seconds and click Deposit/Withdraw again. Meridian fetches fresh on-chain vault state to recalibrate the minimum shares/USDC out floor.
  2. For paused state: Check the status banner or visit the Contract Status page (`/app/status`). If deposits are paused, wait until the administrator re-enables deposits.
  3. For share balance errors: Refresh your positions by clicking "Retry" on the dashboard error banner or reloading the page.
  4. For RPC errors: Testnet RPC can experience occasional transient load; wait 10 seconds and retry.

---

### 8. Stuck Pending Transaction

The transaction was signed and broadcast, but status confirmation is lagging or timing out.

- **Symptom**:
  - The UI button remains on `"Waiting for signature..."` or displays `"Updating your balance..."` without completing.
  - Toast shows: `"Transaction could not be submitted yet (try again later)"` or `"Soroban RPC timed out after 10000ms"`.
  - Toast shows: `"Updating your balance..."` but share count does not update within 30 seconds.
- **Likely Cause**:
  - Network congestion or temporarily high ledger close times on Stellar.
  - The RPC server returned `TRY_AGAIN_LATER` (mempool is full or sequence number is pending).
  - Polling timeout: `waitForTransaction` polled Soroban RPC for 10–30 seconds before receiving a final ledger outcome.
  - Sequence number desynchronization caused by submitting another transaction from the same account simultaneously.
- **Next Action**:
  1. **Do not repeatedly click Deposit/Withdraw**: Submitting duplicate transactions will either fail with `txBadSeq` or lead to multiple unexpected deposits.
  2. Look up your public key on Stellar Expert:
     - [Mainnet Explorer](https://stellar.expert/explorer/public)
     - [Testnet Explorer](https://stellar.expert/explorer/testnet)
  3. Verify whether your transaction was included in the latest ledger:
     - If the transaction succeeded on-chain, simply reload Meridian (`/app`); your position will sync.
     - If the transaction failed or was dropped, wait 30 seconds for the mempool to clear, then initiate the action once more.

---

## Contributor Debugging Tools

When reproducing or diagnosing user reports, developers can inspect contract and account state directly:

### Check Account Balance and Trustlines (Horizon)

```bash
# Testnet
curl -s "https://horizon-testnet.stellar.org/accounts/<WALLET_ADDRESS>" | jq .balances

# Mainnet
curl -s "https://horizon.stellar.org/accounts/<WALLET_ADDRESS>" | jq .balances
```

### Inspect Live Vault Status

Visit `/app/status` in the browser or query the API directly:

```bash
# Read live vault parameters and pools
curl -s "http://localhost:3001/api/v1/vaults" | jq .

# Read keeper operational health
curl -s "http://localhost:3001/api/v1/keepers/health" | jq .
```

### Check Soroban Contract State with Stellar CLI

```bash
# Query vault coordinator total shares on Testnet
stellar contract read \
  --id <VAULT_CONTRACT_ID> \
  --network testnet \
  --durability persistent \
  --key TotalShares
```

### Reference Documentation

- [Signing Flow Architecture](../architecture/signing-flow.md)
- [Frontend Architecture](../architecture/frontend.md)
- [Incident Response Runbook](./incident-response.md)
