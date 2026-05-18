import { getBlendPoolInfo, getDefindexVaultInfo } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";

export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  apy: number;
  tvl: number;
  userBalance: number;
}

const network = STELLAR_NETWORKS.testnet;
const addr = CONTRACT_ADDRESSES.testnet;

export async function fetchAllVaults(): Promise<ApiVault[]> {
  const [blendResult, defindexResult] = await Promise.allSettled([
    getBlendPoolInfo({
      contractId: addr.blend.pool,
      assetId: addr.usdc,
      network,
    }),
    getDefindexVaultInfo({
      contractId: addr.defindex.factory,
      network,
    }),
  ]);

  const vaults: ApiVault[] = [];

  if (blendResult.status === "fulfilled") {
    vaults.push({
      id: "blend-usdc",
      protocol: "blend",
      asset: "USDC",
      apy: Number(blendResult.value.apy.toFixed(2)),
      tvl: Math.round(blendResult.value.tvl),
      userBalance: 0,
    });
  } else {
    console.error("[vaults] blend:", blendResult.reason);
  }

  if (defindexResult.status === "fulfilled") {
    vaults.push({
      id: "defindex-usdc",
      protocol: "defindex",
      asset: "USDC",
      apy: Number(defindexResult.value.apy.toFixed(2)),
      tvl: Math.round(defindexResult.value.tvl),
      userBalance: 0,
    });
  } else {
    console.error("[vaults] defindex:", defindexResult.reason);
  }

  return vaults;
}
