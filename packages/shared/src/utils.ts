export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

import { CONTRACT_ADDRESSES } from "./constants";

type TestnetAddresses = (typeof CONTRACT_ADDRESSES)["testnet"];

/**
 * Resolves the on-chain contract address for a logical DeFindex vault ID.
 * Returns an empty string when the vault is not yet configured.
 * The DEFINDEX_VAULT_ID env var overrides the defindex-usdc entry for
 * backward compatibility with the single-vault setup.
 */
export function defindexContractForVault(
  logicalVaultId: string,
  addresses: TestnetAddresses
): string {
  const registry: Record<string, string> = {
    "defindex-usdc": process.env.DEFINDEX_VAULT_ID || addresses.defindex.vault,
  };
  return registry[logicalVaultId] ?? "";
}
