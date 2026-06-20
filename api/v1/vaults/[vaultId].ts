import { fetchAllVaults } from "@meridian/stellar-sdk-helpers";
import { applyCors } from "../../_lib/middleware";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (applyCors(req, res)) return;
  const { vaultId } = req.query as { vaultId: string };

  try {
    const vaults = await fetchAllVaults();
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return res.status(404).json({ error: "vault not found", vaultId });
    res.json(vault);
  } catch (err) {
    console.error("[vaults] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
}
