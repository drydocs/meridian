import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositions, matchesPositionEtag } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
  sendResponse,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    logError("positions.rate_limit_failed", req, err);
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }
  const { publicKey, refresh } = req.query as {
    publicKey: string;
    refresh?: string;
  };

  const result = await handleGetPositions(publicKey, {
    refresh: refresh === "true" || refresh === "1",
  });
  if (result.error) {
    logError("positions.failed", req, result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  if (result.etag) res.setHeader("ETag", result.etag);
  if (matchesPositionEtag(req.headers["if-none-match"], result.etag)) {
    return res.status(304).end();
  }
  return sendResponse(req, res, result.status, result.body);
}
