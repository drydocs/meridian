import type { VercelRequest, VercelResponse } from "@vercel/node";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";
import { handleGetVaultById } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
  sendResponse,
  vaultReadCacheControl,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";
import { createStrongETag, ifNoneMatchMatches } from "../../_lib/etag.js";

const KNOWN_VAULT_IDS = new Set(
  [
    ...Object.values(KNOWN_POOLS.mainnet),
    ...Object.values(KNOWN_POOLS.testnet),
  ].map((p) => p.id)
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    logError("vault.rate_limit_failed", req, err);
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }
  const raw = req.query["vaultId"];
  const vaultId = typeof raw === "string" ? raw : undefined;
  if (!vaultId)
    return sendResponse(req, res, 400, { error: "vaultId is required" });
  if (!KNOWN_VAULT_IDS.has(vaultId))
    return sendResponse(req, res, 404, { error: "vault not found", vaultId });

  const result = await handleGetVaultById(vaultId);
  if (result.error) {
    logError("vault.failed", req, result.error);
  }
  if (result.status === 200) {
    const body = JSON.stringify(result.body);
    if (body === undefined) {
      throw new TypeError("Vault detail response is not JSON serializable");
    }
    const etag = createStrongETag(body);
    res.setHeader("Cache-Control", vaultReadCacheControl());
    res.setHeader("ETag", etag);
    if (ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
      return res.status(304).end();
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).send(body);
  }
  return sendResponse(req, res, result.status, result.body);
}
