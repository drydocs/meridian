import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetAdminHistory, handleGetVaultState } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
} from "../_lib/middleware.js";

const HISTORY_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=120";

// Consolidated from two separate files (history/vault-state) to stay under
// Vercel's per-deployment serverless functions cap. api/v1/admin/history and api/v1/admin/vault-state are
// unchanged: /api/v1/admin/history and api/v1/admin/vault-state are
// routed here via the [resource].ts dynamic segment, with
// req.query.resource set accordingly. Both are public read-only endpoints
// (same data as the public /api/v1/vaults and /api/v1/pools endpoints).
// Just reshaped for the admin dashboard, so they share one auth model.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (await checkRateLimit(req, res)) return;
  } catch (err) {
    console.error("admin rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable: refusing to run" });
  }

  const { resource } = req.query;

  if (resource === "vault-state") {
    if (!requireGetMethod(req, res)) return;
    const result = await handleGetVaultState();
    if (result.error) console.error("admin/vault-state error:", result.error);
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }

  if (resource === "history") {
    if (!requireGetMethod(req, res)) return;
    const raw = req.query["vaultId"];
    const vaultId = typeof raw === "string" ? raw : undefined;
    if (!vaultId) return res.status(400).json({ error: "vaultId is required" });

    const rawCursor = req.query["cursor"];
    const cursor = typeof rawCursor === "string" ? rawCursor : undefined;

    const result = await handleGetAdminHistory(vaultId, cursor);
    if (result.status === 200) {
      res.setHeader("Cache-Control", HISTORY_CACHE_CONTROL);
    }
    return res.status(result.status).json(result.body);
  }

  return res.status(404).json({ error: "Unknown resource" });
      }
