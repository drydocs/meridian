import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createAdminChallenge,
  handleGetAdminHistory,
  handleGetVaultState,
  verifyAdminChallenge,
} from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

const HISTORY_CACHE_CONTROL = "private, no-store";

// Consolidated from two separate files (history/vault-state) to stay under
// Vercel's per-deployment Serverless Functions cap. URL paths are
// unchanged: /api/v1/admin/history and /api/v1/admin/vault-state both
// route here via the [resource].ts dynamic segment, with
// req.query.resource set accordingly. Admin requests use a signed bearer
// session; a wallet address header is never treated as authentication.
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

  if (resource === "challenge") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const address =
      req.body && typeof req.body.address === "string" ? req.body.address : "";
    const result = await createAdminChallenge(address);
    return res.status(result.status).json(result.body);
  }

  if (resource === "verify") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const body = req.body ?? {};
    const result = await verifyAdminChallenge({
      address: typeof body.address === "string" ? body.address : "",
      challenge: typeof body.challenge === "string" ? body.challenge : "",
      signature: typeof body.signature === "string" ? body.signature : "",
    });
    return res.status(result.status).json(result.body);
  }

  if (resource === "vault-state") {
    const authorization = req.headers.authorization;
    const result = await handleGetVaultState(
      Array.isArray(authorization) ? authorization[0] : authorization
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

    const result = await handleGetAdminHistory(
      vaultId,
      Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization
    );
    if (result.status === 200) {
      res.setHeader("Cache-Control", HISTORY_CACHE_CONTROL);
    }
    return res.status(result.status).json(result.body);
  }

  return res.status(404).json({ error: "Unknown resource" });
}
