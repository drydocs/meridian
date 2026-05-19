import { getStellarStablecoinPools, getDefindexVaultInfo, assessPoolRisk, type RiskLevel } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES, STELLAR_NETWORKS } from "@meridian/shared";

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

const KNOWN_POOLS: Record<string, Pick<ApiVault, "id" | "name" | "protocol" | "label">> = {
  "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf": { id: "blend-usdc-fixed",    name: "Blend Capital", protocol: "blend",  label: "Fixed Rate"     },
  "3a61420f-6f6e-45f9-accc-8d23f5a32d33": { id: "blend-eurc-fixed",    name: "Blend Capital", protocol: "blend",  label: "Fixed Rate"     },
  "48c597dc-9367-4b4a-aa10-49b9755c4c2e": { id: "blend-usdc-variable", name: "Blend Capital", protocol: "blend",  label: "Variable Rate"  },
  "9a2f1f81-0a6e-441d-8219-c13b3520bd57": { id: "blend-eurc-variable", name: "Blend Capital", protocol: "blend",  label: "Variable Rate"  },
  "a66e2d12-188b-407d-aaec-d95640e08ef7": { id: "ondo-usdy",           name: "Ondo Finance",  protocol: "ondo",   label: "Treasury Yield" },
};

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
