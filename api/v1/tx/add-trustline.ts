import { buildTrustlineXdr } from "./_shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { walletAddress } = req.body ?? {};
  if (!walletAddress) return res.status(400).json({ error: "Missing required field: walletAddress" });

  try {
    const result = await buildTrustlineXdr(walletAddress);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build trustline transaction";
    res.status(500).json({ error: msg });
  }
}
