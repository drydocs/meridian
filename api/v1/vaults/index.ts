import { fetchAllVaults, selectBestVault } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES } from "@meridian/shared";

// Cache the aggregated vault list at the Vercel CDN. APY/TVL move slowly, so a
// short fresh window keeps DeFiLlama call volume low, and the stale-while-
// revalidate window lets the edge keep serving the last good payload through a
// transient DeFiLlama outage instead of failing the whole dashboard.
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

const defindexConfigured = Boolean(
  process.env.DEFINDEX_VAULT_ID ?? CONTRACT_ADDRESSES.testnet.defindex.vault
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(_req: any, res: any) {
  try {
    const vaults = await fetchAllVaults();
    const best = selectBestVault(vaults, { defindexConfigured });
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.json({
      vaults,
      recommendedVaultId: best?.id ?? null,
      updatedAt: new Date().toISOString(),
      cached: false,
    });
  } catch (err) {
    console.error("[vaults] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
}
