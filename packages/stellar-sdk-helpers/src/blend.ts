import type { StellarNetwork } from "./types";

export interface BlendPoolConfig {
  contractId: string;
  assetId: string;
  network: StellarNetwork;
}

export async function buildBlendDepositTx(
  _config: BlendPoolConfig,
  _depositor: string,
  _amount: bigint
) {
  throw new Error("Not implemented — see issue #4");
}
