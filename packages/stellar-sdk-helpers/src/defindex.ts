import type { VaultInfo, StellarNetwork } from "./types";

export interface DefindexVaultConfig {
  contractId: string;
  network: StellarNetwork;
}

// DeFindex testnet vault — returns estimated figures until a live vault address
// is deployed and wired into CONTRACT_ADDRESSES
const TESTNET_ESTIMATE: Pick<VaultInfo, "apy" | "tvl"> = {
  apy: 9.2,
  tvl: 85_000,
};

export async function getDefindexVaultInfo(
  _config: DefindexVaultConfig
): Promise<Pick<VaultInfo, "apy" | "tvl">> {
  return TESTNET_ESTIMATE;
}

export async function buildDefindexDepositTx(
  _config: DefindexVaultConfig,
  _depositor: string,
  _amount: bigint
) {
  throw new Error("Not implemented — see issue #5");
}
