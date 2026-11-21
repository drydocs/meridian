import type { StellarNetwork } from "@meridian/stellar-sdk-helpers";
import type { InstrumentationHooks } from "./instrumentation.js";
import type { RetryPolicy } from "./retry.js";

// ---------------------------------------------------------------------------
// High-level vault client types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeout / configuration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Time budgets, in milliseconds. Omitted fields keep their defaults.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// High-level client: simulate / sign / submit / confirm
// ---------------------------------------------------------------------------

/** On-chain status of a submitted transaction. */
export type TransactionStatus =
  | "pending"
  | "success"
  | "failed";

/**
 * Result of a successfully confirmed vault operation.
 */
export interface TransactionResult {
  /** Transaction hash (as reported by the network). */
  hash: string;
  /** Final status of the transaction. */
  status: TransactionStatus;
  /** Ledger sequence the transaction was included in. */
  ledger: number;
  /** Base64-encoded result XDR returned by the network, when available. */
  resultXdr?: string;
}

/**
 * Result of simulating a transaction. Contains the simulation outcome and
 * the prepared, simulation-assembled XDR ready to be signed.
 */
export interface SimulationResult {
  /** Base64-encoded, simulation-assembled transaction XDR ready to sign. */
  xdr: string;
  /** Stroop fee the simulation resolved for the transaction. */
  fee: string;
  /** Estimated ledger number the transaction reaches timeout. */
  latestLedger: number;
  /** Return value of the invocation, as a stringified scval value. */
  returnValue?: string;
}

/**
 * Signs a transaction XDR and returns the signed XDR. The SDK invokes this
 * callback and never stores a secret key.
 */
export type TransactionSigner = (xdr: string) => Promise<string>;

/** Options for `waitForConfirmation`. */
export interface WaitForConfirmationOptions {
  /** Maximum time to wait, in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Polling interval, in milliseconds. Default 1000. */
  pollIntervalMs?: number;
}

/** Error codes emitted by the high-level vault client. */
export type VaultClientErrorCode =
  | "simulation_failed"
  | "signing_rejected"
  | "submission_failed"
  | "confirmation_timeout";

/** Typed error returned by the high-level vault client. */
export interface VaultClientError extends Error {
  /** Machine-readable error code. */
  code: VaultClientErrorCode;
  /** Human-readable message. */
  message: string;
  /** Transaction hash, when known (e.g. on confirmation timeout). */
  hash?: string;
  /** Optional underlying cause. */
  cause?: unknown;
}

/**
 * Result of the complete build -> simulate -> sign -> submit -> confirm
 * flow exposed by the high-level vault client.
 */
export type VaultClientResult =
  | { ok: true; value: TransactionResult }
  | { ok: false; error: VaultClientError };

/**
 * High-level vault client facade. Wraps a VaultBase subclass and exposes
 * simulate, signAndSubmit, and waitForConfirmation helpers. The signer is
 * injected by the caller; the SDK never stores a secret key.
 */
export interface VaultClient {
  /** Simulate a transaction XDR and return the assembled result. */
  simulate(xdr: string): Promise<SimulationResult>;
  /** Sign and submit a transaction XDR, returning the submitted hash. */
  signAndSubmit(xdr: string, signer: TransactionSigner): Promise<{ hash: string }>;
  /** Poll until the transaction is confirmed or the timeout elapses. */
  waitForConfirmation(
    hash: string,
    options?: WaitForConfirmationOptions,
  ): Promise<TransactionResult>;
}
