import { buildWithdrawXdr } from "./_shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { walletAddress, vaultId, shares } = req.body ?? {};
  if (!walletAddress || !vaultId || !shares) {
    const missing = (["walletAddress", "vaultId", "shares"] as const)
      .filter((k) => !req.body?.[k])
      .join(", ");
    return res.status(400).json({ error: `Missing required fields: ${missing}` });
  }

  try {
    const result = await buildWithdrawXdr(walletAddress, shares);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build withdraw transaction";
    res.status(500).json({ error: msg });
  }
}
