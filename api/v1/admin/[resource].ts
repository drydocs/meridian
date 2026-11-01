import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createAdminChallenge,
  handleGetAdminHistory,
  handleGetVaultState,
  verifyAdminChallenge,
} from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
} from "../../_lib/middleware.js";

// Consolidated from two separate files (history/vault-state) to stay under
// Vercel's per-deployment Serverless Functions cap. URL paths are
// unchanged: /api/v1/admin/history and /api/v1/admin/vault-state both
// route here via the [resource].ts dynamic segment, with
// req.query.resource set accordingly.
//
// Auth model:
//   POST /api/v1/admin/challenge  — public; issues a one-time challenge string
//   POST /api/v1/admin/verify     — public; validates wallet signature, returns session token
//   GET  /api/v1/admin/vault-state — protected; requires valid session token
//   GET  /api/v1/admin/history     — protected; requires valid session token
//
// Every protected request re-reads get_admin() on-chain so an admin key
// rotation takes effect immediately without waiting for the session to expire.
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

  // ------------------------------------------------------------------
  // POST /api/v1/admin/challenge
  // Issues a one-time challenge string for the given address to sign.
  // ------------------------------------------------------------------
  if (resource === "challenge") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const body = req.body as Record<string, unknown> | null | undefined;
    const address =
      typeof body?.address === "string" ? body.address : undefined;
    if (!address) {
      return res.status(400).json({ error: "address is required" });
    }
    const result = await createAdminChallenge(address);
    if (result.error) console.error("[admin/challenge] error:", result.error);
    return res.status(result.status).json(result.body);
  }

  // ------------------------------------------------------------------
  // POST /api/v1/admin/verify
  // Validates the wallet signature over the challenge and returns a
  // short-lived HMAC-signed session token.
  // ------------------------------------------------------------------
  if (resource === "verify") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const body = req.body as Record<string, unknown> | null | undefined;
    const address =
      typeof body?.address === "string" ? body.address : undefined;
    const challenge =
      typeof body?.challenge === "string" ? body.challenge : undefined;
    const signature =
      typeof body?.signature === "string" ? body.signature : undefined;

    if (!address || !challenge || !signature) {
      return res
        .status(400)
        .json({ error: "address, challenge and signature are required" });
    }
    const result = await verifyAdminChallenge({
      address,
      challenge,
      signature,
    });
    if (result.error) console.error("[admin/verify] error:", result.error);
    return res.status(result.status).json(result.body);
  }

  // ------------------------------------------------------------------
  // GET /api/v1/admin/vault-state  (protected)
  // ------------------------------------------------------------------
  if (resource === "vault-state") {
    if (requireGetMethod(req, res)) return;
    const authorization = req.headers.authorization;
    const result = await handleGetVaultState(authorization);
    if (result.error) console.error("[admin/vault-state] error:", result.error);
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }

  // ------------------------------------------------------------------
  // GET /api/v1/admin/history  (protected)
  // ------------------------------------------------------------------
  if (resource === "history") {
    if (requireGetMethod(req, res)) return;
    const raw = req.query["vaultId"];
    const vaultId = typeof raw === "string" ? raw : undefined;
    if (!vaultId) return res.status(400).json({ error: "vaultId is required" });

    const authorization = req.headers.authorization;
    const result = await handleGetAdminHistory(vaultId, authorization);
    if (result.error) console.error("[admin/history] error:", result.error);
    // Admin history is user-specific and sensitive; never cache it at the edge.
    res.setHeader("Cache-Control", "no-store");
    return res.status(result.status).json(result.body);
  }

  return res.status(404).json({ error: "Unknown resource" });
}
