import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPublicVaultState } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../_lib/middleware.js";

/** Public, non-sensitive operational state used by /app/status. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await checkRateLimit(req, res))) return;
  const result = await handleGetPublicVaultState();
  if (result.error) console.error("[vault-state] error:", result.error);
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=30, stale-while-revalidate=120"
  );
  return res.status(result.status).json(result.body);
}
