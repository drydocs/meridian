import { fetchVaults } from "./_shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(_req: any, res: any) {
  try {
    const vaults = await fetchVaults();
    res.json({ vaults, updatedAt: new Date().toISOString(), cached: false });
  } catch (err) {
    console.error("[vaults] fetch error:", err);
    res.status(500).json({ error: "Failed to fetch vaults" });
  }
}
