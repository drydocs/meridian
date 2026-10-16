import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetAdminHistory, handleGetVaultState } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

const HISTORY_CACHE_CONTROL = "private, no-store";

// Consolidated from two separate files (history/vault-state) to stay under
// Vercel's per-deployment Serverless Functions cap. URL paths are
// unchanged: /api/v1/admin/history and /api/v1/admin/vault-state both
// route here via the [resource].ts dynamic segment, with
// req.query.resource set accordingly. Both are read-only admin endpoints;
// each request carries the connected wallet address and is checked against
// the vault's live get_admin value.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[admin] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }

  const { resource } = req.query;

  if (resource === "vault-state") {
    const caller = req.headers["x-wallet-address"];
    const result = await handleGetVaultState(
      typeof caller === "string" ? caller : undefined
    );
    if (result.error) console.error("[admin/vault-state] error:", result.error);
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }

  if (resource === "history") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const raw = req.query["vaultId"];
    const vaultId = typeof raw === "string" ? raw : undefined;
    if (!vaultId) return res.status(400).json({ error: "vaultId is required" });

    const caller = req.headers["x-wallet-address"];
    const result = await handleGetAdminHistory(
      vaultId,
      typeof caller === "string" ? caller : undefined
    );
    if (result.status === 200) {
      res.setHeader("Cache-Control", HISTORY_CACHE_CONTROL);
    }
    return res.status(result.status).json(result.body);
  }

  return res.status(404).json({ error: "Unknown resource" });
}
