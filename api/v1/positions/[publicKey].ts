import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositions } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    logError("positions.rate_limit_failed", req, err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }
  const { publicKey } = req.query as { publicKey: string };

  const result = await handleGetPositions(publicKey);
  if (result.error) {
    logError("positions.failed", req, result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
