import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildAddTrustlineTx } from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK, TrustlineRequestSchema, formatZodError } from "@meridian/shared";
import { applyCors, checkRateLimit } from "../../_lib/middleware";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!checkRateLimit(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const parsed = TrustlineRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });

  try {
    const result = await buildAddTrustlineTx(parsed.data.walletAddress, APP_NETWORK);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to build trustline transaction";
    res.status(500).json({ error: msg });
  }
}
