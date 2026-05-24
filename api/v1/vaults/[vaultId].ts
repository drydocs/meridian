import { fetchVaults } from "./_shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const { vaultId } = req.query as { vaultId: string };

  try {
    const vaults = await fetchVaults();
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return res.status(404).json({ error: "vault not found", vaultId });
    res.json(vault);
  } catch (err) {
    console.error("[vaults] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
}
