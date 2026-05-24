import { getStellarStablecoinPools, assessPoolRisk, type RiskLevel } from "./defilamma";
import { getDefindexVaultInfo } from "./defindex";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";
import { KNOWN_POOLS } from "./known-pools";

export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex" | "ondo";
  asset: string;
  name: string;
  label: string;
  apy: number;
  tvl: number;
  userBalance: number;
  riskLevel: RiskLevel;
}

const network = STELLAR_NETWORKS.testnet;
const addr = CONTRACT_ADDRESSES.testnet;

export async function fetchAllVaults(): Promise<ApiVault[]> {
  const [stellarPoolsResult, defindexResult] = await Promise.allSettled([
    getStellarStablecoinPools(),
    getDefindexVaultInfo({ contractId: addr.defindex.factory, network }),
  ]);

  const vaults: ApiVault[] = [];

  if (stellarPoolsResult.status === "fulfilled") {
    for (const pool of stellarPoolsResult.value) {
      const meta = KNOWN_POOLS[pool.pool];
      if (!meta) {
        console.warn("[vaults] unknown DeFiLlama pool, skipping:", pool.pool, pool.project, pool.symbol);
        continue;
      }
      vaults.push({
        ...meta,
        asset: pool.symbol,
        apy: Number(pool.apy.toFixed(2)),
        tvl: Math.round(pool.tvlUsd),
        userBalance: 0,
        riskLevel: assessPoolRisk(pool),
      });
    }
  } else {
    console.error("[vaults] DeFiLlama fetch failed:", stellarPoolsResult.reason);
  }

  if (defindexResult.status === "fulfilled") {
    vaults.push({
      id: "defindex-usdc",
      protocol: "defindex",
      asset: "USDC",
      name: "DeFindex",
      label: "Yield Strategy",
      apy: Number(defindexResult.value.apy.toFixed(2)),
      tvl: Math.round(defindexResult.value.tvl),
      userBalance: 0,
      riskLevel: "safe" as RiskLevel,
    });
  } else {
    console.error("[vaults] defindex:", defindexResult.reason);
  }

  return vaults;
}
