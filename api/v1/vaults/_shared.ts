import KNOWN_POOLS_RAW from "../../../packages/stellar-sdk-helpers/src/known-pools.json";

type RiskLevel = "safe" | "caution" | "risky";

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

interface Pool {
  pool: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyPct7D: number | null;
  stablecoin: boolean;
  chain: string;
}

const KNOWN_POOLS = KNOWN_POOLS_RAW as Record<string, Pick<ApiVault, "id" | "name" | "protocol" | "label">>;

function assessPoolRisk(pool: Pool): RiskLevel {
  let score = 0;

  if (pool.tvlUsd < 10_000)         score += 3;
  else if (pool.tvlUsd < 100_000)   score += 2;
  else if (pool.tvlUsd < 2_000_000) score += 1;

  const vol7d = Math.abs(pool.apyPct7D ?? 0);
  if (vol7d > 30)     score += 3;
  else if (vol7d > 5) score += 2;
  else if (vol7d > 1) score += 1;

  if (pool.apy > 20)      score += 2;
  else if (pool.apy > 12) score += 1;

  return score >= 4 ? "risky" : score >= 2 ? "caution" : "safe";
}

export async function fetchVaults(): Promise<ApiVault[]> {
  const res = await fetch("https://yields.llama.fi/pools", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  const json = (await res.json()) as { data: Pool[] };

  const vaults: ApiVault[] = [];
  for (const pool of json.data) {
    if (pool.chain !== "Stellar" || !pool.stablecoin || pool.apy < 0.01 || pool.tvlUsd < 1_000) continue;
    const meta = KNOWN_POOLS[pool.pool];
    if (!meta) continue;
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
