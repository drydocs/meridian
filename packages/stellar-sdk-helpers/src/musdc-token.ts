import { Address, nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import { CONTRACT_ADDRESSES } from "@meridian/shared";
import { getRpcServer } from "./internal";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";

/**
 * Typed errors for mUSDC token operations. Callers can catch these to provide
 * specific error handling rather than catching a generic Error.
 */
export class InvalidAddressError extends Error {
  constructor(address: string) {
    super(`Invalid Stellar address: ${address}`);
    this.name = "InvalidAddressError";
  }
}

export class TokenRpcError extends Error {
  constructor(operation: string, cause?: unknown) {
    super(`Failed to read ${operation} from token contract`);
    this.name = "TokenRpcError";
    this.cause = cause;
  }
}

/**
 * Validate a Stellar account address (G... format). Throws
 * {@link InvalidAddressError} if the address is not a valid Stellar account key.
 */
function validateAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new InvalidAddressError(address);
  }
}

/**
 * Read the mUSDC balance for the given address from the SEP-41 token contract.
 * Returns the balance in stroops (7 decimals). Returns 0n when the account
 * holds no balance or when the trustline does not exist.
 *
 * This reads the token contract directly and is independent of vault share
 * pricing. A wallet balance of 100 mUSDC means the holder can transfer or
 * burn that amount; it does not reflect the underlying USDC value that
 * redeeming vault shares would return (see computePosition for share value).
 *
 * @param network - The Stellar network configuration (testnet or mainnet)
 * @param address - The Stellar account address (G... format)
 * @returns The mUSDC balance in stroops
 * @throws {@link InvalidAddressError} when the address is not a valid Stellar account
 * @throws {@link TokenRpcError} when the RPC call fails
 *
 * @example
 * ```ts
 * const balance = await getBalance(
 *   { network: "testnet", rpcUrl: "...", passphrase: "..." },
 *   "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
 * );
 * console.log(`Balance: ${balance / 1e7} mUSDC`);
 * ```
 */
export async function getBalance(
  network: StellarNetwork,
  address: string
): Promise<bigint> {
  validateAddress(address);

  const contractId =
    network.network === "mainnet"
      ? CONTRACT_ADDRESSES.mainnet.musdc
      : CONTRACT_ADDRESSES.testnet.musdc;

  if (!contractId) {
    throw new TokenRpcError(
      "balance",
      new Error(`No mUSDC contract deployed on ${network.network}`)
    );
  }

  const server = getRpcServer(network.rpcUrl, 10_000);
  const addressScVal = Address.fromString(address).toScVal();

  try {
    const result = await simulateView(
      server,
      contractId,
      network.passphrase,
      "balance",
      addressScVal
    );
    // SEP-41 balance returns i128. simulateView decodes to bigint or number.
    if (typeof result === "bigint") return result;
    if (typeof result === "number") return BigInt(result);
    // Missing trustline or zero balance typically returns 0 or null.
    return 0n;
  } catch (err) {
    throw new TokenRpcError("balance", err);
  }
}

/**
 * Read the mUSDC allowance granted by `owner` to `spender` from the SEP-41
 * token contract. Returns the allowance in stroops (7 decimals). Returns 0n
 * when no allowance is set or when the trustline does not exist.
 *
 * Allowances let a spender transfer tokens on behalf of the owner without the
 * owner signing each transaction. The vault uses this pattern: a user approves
 * the vault to spend mUSDC, then calls deposit without needing to sign a
 * separate token transfer.
 *
 * @param network - The Stellar network configuration (testnet or mainnet)
 * @param owner - The Stellar account that granted the allowance (G... format)
 * @param spender - The Stellar account or contract authorized to spend (G... or C... format)
 * @returns The allowance in stroops
 * @throws {@link InvalidAddressError} when either address is invalid
 * @throws {@link TokenRpcError} when the RPC call fails
 *
 * @example
 * ```ts
 * const allowance = await getAllowance(
 *   network,
 *   "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
 *   CONTRACT_ADDRESSES.testnet.vault
 * );
 * console.log(`Vault can spend ${allowance / 1e7} mUSDC`);
 * ```
 */
export async function getAllowance(
  network: StellarNetwork,
  owner: string,
  spender: string
): Promise<bigint> {
  validateAddress(owner);
  // Spender can be a contract (C...) or account (G...), so validate both forms.
  if (
    !StrKey.isValidEd25519PublicKey(spender) &&
    !StrKey.isValidContract(spender)
  ) {
    throw new InvalidAddressError(spender);
  }

  const contractId =
    network.network === "mainnet"
      ? CONTRACT_ADDRESSES.mainnet.musdc
      : CONTRACT_ADDRESSES.testnet.musdc;

  if (!contractId) {
    throw new TokenRpcError(
      "allowance",
      new Error(`No mUSDC contract deployed on ${network.network}`)
    );
  }

  const server = getRpcServer(network.rpcUrl, 10_000);
  const ownerScVal = Address.fromString(owner).toScVal();
  const spenderScVal = Address.fromString(spender).toScVal();

  try {
    const result = await simulateView(
      server,
      contractId,
      network.passphrase,
      "allowance",
      ownerScVal,
      spenderScVal
    );
    // SEP-41 allowance returns i128.
    if (typeof result === "bigint") return result;
    if (typeof result === "number") return BigInt(result);
    return 0n;
  } catch (err) {
    throw new TokenRpcError("allowance", err);
  }
}

/**
 * Check whether the given address has a trustline to the mUSDC token. Returns
 * true when the account has established a trustline (even if the balance is
 * zero), and false when no trustline exists.
 *
 * A missing trustline means the account cannot receive mUSDC transfers. This
 * is distinct from a zero balance: an account with a zero-balance trustline
 * can receive tokens, but an account with no trustline at all cannot.
 *
 * For SEP-41 contracts, a trustline is typically implicit after any
 * interaction with the token (balance, approve, transfer). This helper reads
 * the balance and treats any non-error response as proof of the trustline.
 *
 * @param network - The Stellar network configuration (testnet or mainnet)
 * @param address - The Stellar account address (G... format)
 * @returns true if the trustline exists, false otherwise
 * @throws {@link InvalidAddressError} when the address is invalid
 * @throws {@link TokenRpcError} when the RPC call fails for reasons other than a missing trustline
 *
 * @example
 * ```ts
 * const hasTrustline = await hasTrustline(network, userAddress);
 * if (!hasTrustline) {
 *   console.log("User must establish a trustline before receiving mUSDC");
 * }
 * ```
 */
export async function hasTrustline(
  network: StellarNetwork,
  address: string
): Promise<boolean> {
  validateAddress(address);

  const contractId =
    network.network === "mainnet"
      ? CONTRACT_ADDRESSES.mainnet.musdc
      : CONTRACT_ADDRESSES.testnet.musdc;

  if (!contractId) {
    throw new TokenRpcError(
      "trustline check",
      new Error(`No mUSDC contract deployed on ${network.network}`)
    );
  }

  const server = getRpcServer(network.rpcUrl, 10_000);
  const addressScVal = Address.fromString(address).toScVal();

  try {
    // A successful balance read means the trustline exists, even if balance is 0.
    await simulateView(
      server,
      contractId,
      network.passphrase,
      "balance",
      addressScVal
    );
    return true;
  } catch (err) {
    // SEP-41 tokens typically return a contract error when no trustline exists.
    // Distinguishing "no trustline" from "RPC failure" is hard without inspecting
    // the error deeply. For now, treat any error as "no trustline" since that's
    // the most common case and safer than throwing (a false negative is better
    // than blocking a legitimate user). Callers that need to distinguish can
    // catch TokenRpcError and inspect the cause.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("does not exist") || message.includes("not found")) {
      return false;
    }
    // If it's a genuine RPC failure (timeout, network error), rethrow.
    if (
      message.includes("timeout") ||
      message.includes("RPC") ||
      message.includes("network")
    ) {
      throw new TokenRpcError("trustline check", err);
    }
    // Default to false for unrecognized contract errors (likely "no trustline").
    return false;
  }
}
