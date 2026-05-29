import { buildDepositXdr } from "./_shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { walletAddress, vaultId, amount } = req.body ?? {};
  if (!walletAddress || !vaultId || !amount) {
    const missing = (["walletAddress", "vaultId", "amount"] as const)
      .filter((k) => !req.body?.[k])
      .join(", ");
    return res.status(400).json({ error: `Missing required fields: ${missing}` });
  }

  try {
    const result = await buildDepositXdr(walletAddress, vaultId, amount);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build deposit transaction";
    res.status(500).json({ error: msg });
  }
}
