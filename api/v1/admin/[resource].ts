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
  sendResponse,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    logError("admin.rate_limit_failed", req, err);
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }

  const resource =
    typeof req.query?.resource === "string" ? req.query.resource : undefined;
  if (resource === "challenge") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendResponse(req, res, 405, { error: "Method not allowed" });
    }
    const body = req.body as Record<string, unknown> | null | undefined;
    const address =
      typeof body?.address === "string" ? body.address : undefined;
    if (!address)
      return sendResponse(req, res, 400, { error: "address is required" });
    const result = await createAdminChallenge(address);
    if (result.error) logError("admin.challenge_failed", req, result.error);
    return sendResponse(req, res, result.status, result.body);
  }

  if (resource === "verify") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendResponse(req, res, 405, { error: "Method not allowed" });
    }
    const body = req.body as Record<string, unknown> | null | undefined;
    const address =
      typeof body?.address === "string" ? body.address : undefined;
    const challenge =
      typeof body?.challenge === "string" ? body.challenge : undefined;
    const signature =
      typeof body?.signature === "string" ? body.signature : undefined;
    if (!address || !challenge || !signature) {
      return sendResponse(req, res, 400, {
        error: "address, challenge and signature are required",
      });
    }
    const result = await verifyAdminChallenge({
      address,
      challenge,
      signature,
    });
    if (result.error) logError("admin.verify_failed", req, result.error);
    return sendResponse(req, res, result.status, result.body);
  }

  if (resource === "vault-state") {
    if (requireGetMethod(req, res)) return;
    const result = await handleGetVaultState(req.headers.authorization);
    if (result.error) logError("admin.vault_state_failed", req, result.error);
    res.setHeader("Cache-Control", "no-store");
    return sendResponse(req, res, result.status, result.body);
  }

  if (resource === "history") {
    if (requireGetMethod(req, res)) return;
    const raw = req.query["vaultId"];
    const vaultId = typeof raw === "string" ? raw : undefined;
    if (!vaultId)
      return sendResponse(req, res, 400, { error: "vaultId is required" });
    const result = await handleGetAdminHistory(
      vaultId,
      req.headers.authorization
    );
    if (result.error) logError("admin.history_failed", req, result.error);
    res.setHeader("Cache-Control", "no-store");
    return sendResponse(req, res, result.status, result.body);
  }

  return sendResponse(req, res, 404, { error: "Unknown resource" });
}
