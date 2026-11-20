import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositions } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
  getRequestId,
  sendResponse,
} from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[positions] rate limit check failed:", {
      requestId: getRequestId(req),
      error: err,
    });
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }
  const { publicKey } = req.query as { publicKey: string };

  const result = await handleGetPositions(publicKey);
  if (result.error) {
    console.error("[positions] error:", {
      requestId: getRequestId(req),
      error: result.error,
    });
  }
  res.setHeader("Cache-Control", "no-store");
  return sendResponse(req, res, result.status, result.body);
}
