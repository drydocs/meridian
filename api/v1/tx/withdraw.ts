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

  // TODO(#issue-7): build unsigned Soroban withdraw tx, return XDR for wallet signing
  res.status(501).json({ error: "Withdrawal signing not yet implemented" });
}
