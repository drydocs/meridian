import { buildBlendDepositTx, buildBlendWithdrawTx, blendAssetForVault } from "./blend";
import { buildDefindexDepositTx, buildDefindexWithdrawTx } from "./defindex";
import { toStroops, resolveProtocol } from "./tx";
import type { StellarNetwork } from "./types";

export interface ProtocolAddresses {
  blendPool: string;
  usdc: string;
  eurc: string;
  defindexVault: string;
}

export async function buildDepositTx(
  vaultId: string,
  walletAddress: string,
  amount: string,
  addresses: ProtocolAddresses,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  if (resolveProtocol(vaultId) === "Blend") {
    const asset = blendAssetForVault(vaultId);
    return buildBlendDepositTx(
      { poolId: addresses.blendPool, assetId: addresses[asset], network },
      walletAddress,
      toStroops(amount)
    );
  }
  if (!addresses.defindexVault) {
    throw new Error("DeFindex vault not configured. Set DEFINDEX_VAULT_ID.");
  }
  return buildDefindexDepositTx(
    { vaultId: addresses.defindexVault, network },
    walletAddress,
    toStroops(amount)
  );
}

export async function buildWithdrawTx(
  vaultId: string,
  walletAddress: string,
  amount: string,
  addresses: ProtocolAddresses,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  if (resolveProtocol(vaultId) === "Blend") {
    const asset = blendAssetForVault(vaultId);
    return buildBlendWithdrawTx(
      { poolId: addresses.blendPool, assetId: addresses[asset], network },
      walletAddress,
      toStroops(amount)
    );
  }
  if (!addresses.defindexVault) {
    throw new Error("DeFindex vault not configured. Set DEFINDEX_VAULT_ID.");
  }
  return buildDefindexWithdrawTx(
    { vaultId: addresses.defindexVault, network },
    walletAddress,
    toStroops(amount)
  );
}
