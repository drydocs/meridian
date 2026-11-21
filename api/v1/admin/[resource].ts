import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetAdminHistory, handleGetVaultState } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  getRequestId,
  requireGetMethod,
  sendResponse,
} from "../../_lib/middleware.js";

const HISTORY_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=120";

// Consolidated from two separate files (history/vault-state) to stay under
// Vercel's per-deployment Serverless Functions cap. URL paths are
// unchanged: /api/v1/admin/history and /api/v1/admin/vault-state both
// route here via the [resource].ts dynamic segment, with
// req.query.resource set accordingly. Both are public read-only endpoints
// (same data as the public /api/v1/vaults and /api/v1/positions routes,
// just reshaped for the admin dashboard), so they share one auth model.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[admin] rate limit check failed:", {
      requestId: getRequestId(req),
      error: err,
    });
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }

  const { resource } = req.query;

  if (resource === "vault-state") {
    if (requireGetMethod(req, res)) return;
    const result = await handleGetVaultState();
    if (result.error)
      console.error("[admin/vault-state] error:", {
        requestId: getRequestId(req),
        error: result.error,
      });
    res.setHeader("Cache-Control", "no-store");
    return sendResponse(req, res, result.status, result.body);
  }

  if (resource === "history") {
    if (requireGetMethod(req, res)) return;
    const raw = req.query["vaultId"];
    const vaultId = typeof raw === "string" ? raw : undefined;
    if (!vaultId)
      return sendResponse(req, res, 400, { error: "vaultId is required" });

    const result = await handleGetAdminHistory(vaultId);
    if (result.status === 200) {
      res.setHeader("Cache-Control", HISTORY_CACHE_CONTROL);
    }
    return sendResponse(req, res, result.status, result.body);
  }

  return sendResponse(req, res, 404, { error: "Unknown resource" });
}
