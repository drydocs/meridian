type RiskLevel = "safe" | "caution" | "risky";

interface KnownPoolMeta {
  id: string;
  name: string;
  protocol: "blend" | "defindex" | "ondo";
  label: string;
}

const KNOWN_POOLS: Record<string, KnownPoolMeta> = {
  "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf": { id: "blend-usdc-fixed",    name: "Blend Capital", protocol: "blend", label: "Fixed Rate"     },
  "3a61420f-6f6e-45f9-accc-8d23f5a32d33": { id: "blend-eurc-fixed",    name: "Blend Capital", protocol: "blend", label: "Fixed Rate"     },
  "48c597dc-9367-4b4a-aa10-49b9755c4c2e": { id: "blend-usdc-variable", name: "Blend Capital", protocol: "blend", label: "Variable Rate"  },
  "9a2f1f81-0a6e-441d-8219-c13b3520bd57": { id: "blend-eurc-variable", name: "Blend Capital", protocol: "blend", label: "Variable Rate"  },
  "a66e2d12-188b-407d-aaec-d95640e08ef7": { id: "ondo-usdy",           name: "Ondo Finance",  protocol: "ondo",  label: "Treasury Yield" },
};

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
