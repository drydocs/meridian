// Blend Protocol integration helpers
// Docs: https://docs.blend.capital

import { Contract, rpc } from "@stellar/stellar-sdk";
import type { VaultInfo, StellarNetwork } from "./types";

export interface BlendPoolConfig {
  contractId: string;
  network: StellarNetwork;
}

// Returns basic pool APY and TVL — full implementation requires
// decoding Blend's pool data entries via soroban-client
export async function getBlendPoolInfo(
  config: BlendPoolConfig
): Promise<Pick<VaultInfo, "apy" | "tvl">> {
  // TODO(#issue-4): implement Blend pool data decoding
  throw new Error("Not implemented — see issue #4");
}

export async function buildBlendDepositTx(
  config: BlendPoolConfig,
  depositor: string,
  amount: bigint
) {
  // TODO(#issue-4): build and return unsigned Soroban transaction
  throw new Error("Not implemented — see issue #4");
}
