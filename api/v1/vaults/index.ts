import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetVaults } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
  vaultReadCacheControl,
} from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res, { route: "read" }))) return;
  } catch (err) {
    logError("vaults.rate_limit_failed", req, err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }

  const result = await handleGetVaults();
  if (result.error) {
    logError("vaults.failed", req, result.error);
  }
  if (result.status === 200) {
    res.setHeader("Cache-Control", vaultReadCacheControl());
  }
  res.status(result.status).json(result.body);
}
