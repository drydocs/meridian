import { getBlendPoolInfo, getDefindexVaultInfo, BLEND_DEFILLAMA_POOLS } from "@meridian/stellar-sdk-helpers";
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
  const [blendUsdcResult, blendEurcResult, defindexResult] = await Promise.allSettled([
    getBlendPoolInfo({
      contractId: addr.blend.pool,
      assetId: addr.usdc,
      defiLlamaPoolId: BLEND_DEFILLAMA_POOLS.USDC,
      network,
    }),
    getBlendPoolInfo({
      contractId: addr.blend.pool,
      assetId: addr.eurc,
      defiLlamaPoolId: BLEND_DEFILLAMA_POOLS.EURC,
      network,
    }),
    getDefindexVaultInfo({
      contractId: addr.defindex.factory,
      network,
    }),
  ]);

  const vaults: ApiVault[] = [];

  if (blendUsdcResult.status === "fulfilled") {
    vaults.push({
      id: "blend-usdc",
      protocol: "blend",
      asset: "USDC",
      apy: Number(blendUsdcResult.value.apy.toFixed(2)),
      tvl: Math.round(blendUsdcResult.value.tvl),
      userBalance: 0,
    });
  } else {
    console.error("[vaults] blend-usdc:", blendUsdcResult.reason);
  }

  if (blendEurcResult.status === "fulfilled") {
    vaults.push({
      id: "blend-eurc",
      protocol: "blend",
      asset: "EURC",
      apy: Number(blendEurcResult.value.apy.toFixed(2)),
      tvl: Math.round(blendEurcResult.value.tvl),
      userBalance: 0,
    });
  } else {
    console.error("[vaults] blend-eurc:", blendEurcResult.reason);
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
