import type { VaultInfo, StellarNetwork } from "./types";

export interface BlendPoolConfig {
  contractId: string;
  assetId: string;
  network: StellarNetwork;
}

// DeFiLlama chart UUID for the Blend Capital USDC Fixed Pool (mainnet)
// https://yields.llama.fi/chart/ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf
const DEFILLAMA_BLEND_USDC =
  "https://yields.llama.fi/chart/ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf";

const FALLBACK: Pick<VaultInfo, "apy" | "tvl"> = { apy: 6.8, tvl: 180_000 };

interface DeFiLlamaChart {
  status: string;
  data: { timestamp: string; tvlUsd: number; apy: number }[];
}

export async function getBlendPoolInfo(
  _config: BlendPoolConfig
): Promise<Pick<VaultInfo, "apy" | "tvl">> {
  try {
    const res = await fetch(DEFILLAMA_BLEND_USDC, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = (await res.json()) as DeFiLlamaChart;
    if (!json.data?.length) throw new Error("empty data array");

    const latest = json.data[json.data.length - 1];
    return { apy: latest.apy, tvl: latest.tvlUsd };
  } catch (err) {
    console.warn("[blend] DeFiLlama fetch failed, using fallback:", (err as Error).message);
    return FALLBACK;
  }
}

export async function buildBlendDepositTx(
  _config: BlendPoolConfig,
  _depositor: string,
  _amount: bigint
) {
  throw new Error("Not implemented — see issue #4");
}
