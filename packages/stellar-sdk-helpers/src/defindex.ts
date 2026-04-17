// DeFindex Protocol integration helpers
// Docs: https://docs.defindex.io

import type { VaultInfo, StellarNetwork } from "./types";

export interface DefindexVaultConfig {
  contractId: string;
  network: StellarNetwork;
}

export async function getDefindexVaultInfo(
  config: DefindexVaultConfig
): Promise<Pick<VaultInfo, "apy" | "tvl">> {
  // TODO(#issue-5): implement DeFindex vault data decoding
  throw new Error("Not implemented — see issue #5");
}

export async function buildDefindexDepositTx(
  config: DefindexVaultConfig,
  depositor: string,
  amount: bigint
) {
  // TODO(#issue-5): build and return unsigned Soroban transaction
  throw new Error("Not implemented — see issue #5");
}
