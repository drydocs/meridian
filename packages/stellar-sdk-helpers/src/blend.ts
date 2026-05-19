import type { VaultInfo, StellarNetwork } from "./types";

export interface BlendPoolConfig {
  contractId: string;
  assetId: string;
  defiLlamaPoolId: string;
  network: StellarNetwork;
}

const DEFILLAMA_CHART_BASE = "https://yields.llama.fi/chart";

export const BLEND_DEFILLAMA_POOLS = {
  USDC: "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf",
  EURC: "3a61420f-6f6e-45f9-accc-8d23f5a32d33",
} as const;

const FALLBACKS: Record<string, Pick<VaultInfo, "apy" | "tvl">> = {
  [BLEND_DEFILLAMA_POOLS.USDC]: { apy: 6.8, tvl: 180_000 },
  [BLEND_DEFILLAMA_POOLS.EURC]: { apy: 5.5, tvl: 60_000 },
};

interface DeFiLlamaChart {
  status: string;
  data: { timestamp: string; tvlUsd: number; apy: number }[];
}

export async function getBlendPoolInfo(
  config: BlendPoolConfig
): Promise<Pick<VaultInfo, "apy" | "tvl">> {
  const fallback = FALLBACKS[config.defiLlamaPoolId] ?? { apy: 5.0, tvl: 0 };
  try {
    const res = await fetch(`${DEFILLAMA_CHART_BASE}/${config.defiLlamaPoolId}`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = (await res.json()) as DeFiLlamaChart;
    if (!json.data?.length) throw new Error("empty data array");

    const latest = json.data[json.data.length - 1];
    return { apy: latest.apy, tvl: latest.tvlUsd };
  } catch (err) {
    console.warn("[blend] DeFiLlama fetch failed, using fallback:", (err as Error).message);
    return fallback;
  }
}

export async function buildBlendDepositTx(
  _config: BlendPoolConfig,
  _depositor: string,
  _amount: bigint
) {
  throw new Error("Not implemented — see issue #4");
}
