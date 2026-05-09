// Blend Protocol integration helpers
// Docs: https://docs.blend.capital

import type { VaultInfo, StellarNetwork } from "./types";

export interface BlendPoolConfig {
  contractId: string;
  network: StellarNetwork;
}

export async function getBlendPoolInfo(
  _config: BlendPoolConfig
): Promise<Pick<VaultInfo, "apy" | "tvl">> {
  // TODO(#issue-4): implement Blend pool data decoding
  throw new Error("Not implemented — see issue #4");
}

export async function buildBlendDepositTx(
  _config: BlendPoolConfig,
  _depositor: string,
  _amount: bigint
) {
  // TODO(#issue-4): build and return unsigned Soroban transaction
  throw new Error("Not implemented — see issue #4");
}
