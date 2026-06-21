import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fetchAllVaults } from "@meridian/stellar-sdk-helpers";
import { applyCors } from "../../_lib/middleware";

const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  const { vaultId } = req.query as { vaultId: string };

  try {
    const vaults = await fetchAllVaults();
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return res.status(404).json({ error: "vault not found", vaultId });
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.json(vault);
  } catch (err) {
    console.error("[vaults] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
}
