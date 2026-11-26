import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetVaults } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
  sendResponse,
  vaultReadCacheControl,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";
import { createStrongETag, ifNoneMatchMatches } from "../../_lib/etag.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    logError("vaults.rate_limit_failed", req, err);
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }

  const result = await handleGetVaults();
  if (result.error) {
    logError("vaults.failed", req, result.error);
  }
  if (result.status === 200) {
    const body = JSON.stringify(result.body);
    if (body === undefined) {
      throw new TypeError("Vault list response is not JSON serializable");
    }
    // updatedAt and cached change on every request, so they stay out of the
    // tag. It then only changes when the vaults or the recommendation do.
    const {
      updatedAt: _updatedAt,
      cached: _cached,
      ...stable
    } = result.body as Record<string, unknown>;
    const etag = createStrongETag(JSON.stringify(stable));
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
