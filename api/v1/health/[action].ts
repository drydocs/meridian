import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetLiveness, handleGetReadiness } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  sendResponse,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  const { action } = req.query;
  if (action !== "live" && action !== "ready") {
    return sendResponse(req, res, 404, { error: "Unknown health action" });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendResponse(req, res, 405, { error: "Method not allowed" });
  }

  if (action === "ready") {
    try {
      if (!(await checkRateLimit(req, res))) return;
    } catch (err) {
      logError("health.rate_limit_failed", req, err);
      return sendResponse(req, res, 503, {
        error: "Rate limiter unavailable; refusing to run",
      });
    }
  }

  const result =
    action === "live" ? handleGetLiveness() : await handleGetReadiness();
  res.setHeader("Cache-Control", "no-store");
  return sendResponse(req, res, result.status, result.body);
}
