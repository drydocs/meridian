import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositionHistory } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  getRequestId,
  sendResponse,
} from "../../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendResponse(req, res, 405, { error: "Method not allowed" });
  }
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[positions/history] rate limit check failed:", {
      requestId: getRequestId(req),
      error: err,
    });
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }
  const { publicKey, days } = req.query as {
    publicKey: string;
    days?: string;
  };

  const result = await handleGetPositionHistory(publicKey, days);
  if (result.error) {
    console.error("[positions/history] error:", {
      requestId: getRequestId(req),
      error: result.error,
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return sendResponse(req, res, result.status, result.body);
}
