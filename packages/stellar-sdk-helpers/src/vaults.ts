import { getStellarStablecoinPools, assessPoolRisk, type RiskLevel } from "./defilamma";
import { KNOWN_POOLS } from "./known-pools";

export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  name: string;
  label: string;
  apy: number;
  tvl: number;
  userBalance: number;
  riskLevel: RiskLevel;
}

// Every vault in the list is backed by live DeFiLlama market data. Protocols
// without a real on-chain rate feed wired up yet are intentionally omitted
// rather than shown with placeholder figures.
export async function fetchAllVaults(): Promise<ApiVault[]> {
  const pools = await getStellarStablecoinPools();

  const vaults: ApiVault[] = [];
  for (const pool of pools) {
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

  return vaults;
}
