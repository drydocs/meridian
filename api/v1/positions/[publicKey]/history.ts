import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositionHistory } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  sendResponse,
} from "../../../_lib/middleware.js";
import { logError } from "../../../_lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendResponse(req, res, 405, { error: "Method not allowed" });
  }
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    logError("positions.history.rate_limit_failed", req, err);
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }
  const { publicKey, days, resolution, limit, cursor } = req.query as {
    publicKey: string;
    days?: string;
    resolution?: string;
    limit?: string;
    cursor?: string;
  };

  const result = await handleGetPositionHistory(
    publicKey,
    days,
    resolution,
    limit,
    cursor
  );
  if (result.error) {
    logError("positions.history.failed", req, result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  return sendResponse(req, res, result.status, result.body);
}
