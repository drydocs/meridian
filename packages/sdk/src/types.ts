import type { StellarNetwork } from "@meridian/stellar-sdk-helpers";
import type { InstrumentationHooks } from "./instrumentation.js";
import type { RetryPolicy } from "./retry.js";

/** Time budgets, in milliseconds. Omitted fields keep their defaults. */
export interface TimeoutOptions {
  /** HTTP timeout of the Soroban RPC client. Default 12000. */
  rpcMs?: number;
  /**
   * Overall budget for one SDK call attempt (all its RPC round trips).
   * Default: none, so behaviour matches earlier releases.
   */
  operationMs?: number;
}

/**
 * Configuration required to connect a VaultBase instance to an on-chain
 * MeridianVault coordinator contract.
 */
export interface VaultConfig {
  /** Bech32 contract address (C-address) of the MeridianVault coordinator. */
  contractId: string;
  /** Stellar network context (network id, RPC URL, passphrase). */
  network: StellarNetwork;
  /** Timeout overrides. Defaults to a 12000ms RPC timeout. */
  timeouts?: TimeoutOptions;
  /** Opt-in retry policy. No retries when omitted. */
  retry?: RetryPolicy;
  /** Optional telemetry hooks; payloads are redacted before delivery. */
  hooks?: InstrumentationHooks;
}

/**
 * A caller's current on-chain position in a vault.
 *
 * All asset/share values are in stroops (1 USDC = 10_000_000 stroops) to
 * preserve precision across the full bigint computation chain. Callers that
 * need human-readable display values should divide by 10_000_000n.
 */
export interface Position {
  /** Vault contract address this position belongs to. */
  vaultId: string;
  /** Number of mUSDC shares held by the account (stroops). */
  shares: bigint;
  /** Current redemption value of those shares in USDC (stroops). */
  deposited: bigint;
  /** Yield earned above the cost basis (stroops). Zero when no basis is recorded. */
  earned: bigint;
  /** Unix timestamp (seconds) when the position was first opened. */
  entryTime: number;
  /** USDC cost basis stored on-chain via the vault's principal tracking (stroops). */
  principal: bigint;
}

/**
 * Result of a state-changing vault operation. The caller receives an unsigned
 * Soroban transaction XDR that must be signed by the account's private key
 * and submitted to the network.
 */
export interface Transaction {
  /** Base64-encoded unsigned Soroban transaction XDR. */
  xdr: string;
  /** Total assembled transaction fee in stroops, including the inclusion fee. */
  fee: string;
}

/**
 * Quote returned by the vault's `preview_withdraw` view. All values are in
 * stroops and match what `withdraw` pays and mints at the same vault state.
 */
export interface WithdrawPreview {
  /** USDC redeemed from the adapter for the burned shares, before the fee. */
  grossAssets: bigint;
  /** Performance fee charged on the gain over the retired cost basis. */
  fee: bigint;
  /** mUSDC minted to the treasury for that fee. */
  treasuryShares: bigint;
  /** USDC the caller receives. */
  assetsOut: bigint;
  /** Maximum USDC currently liquid and withdrawable from the adapter (stroops). */
  availableLiquidity: bigint;
}

/**
 * On-chain information about the vault's currently active yield adapter.
 */
export interface AdapterInfo {
  /** Bech32 contract address (C-address) of the adapter contract. */
  adapterId: string;
  /** Protocol identifier reported by the adapter (e.g. "blend", "defindex"). */
  protocol: string;
  /** Total USDC assets under management by this adapter (stroops). */
  totalAssets: bigint;
}
