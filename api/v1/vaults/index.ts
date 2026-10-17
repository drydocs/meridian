import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetVaults } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  vaultReadCacheControl,
} from "../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[vaults] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }

  const result = await handleGetVaults();
  if (result.error) {
    console.error("[vaults] fetch error:", result.error);
  }
  if (result.status === 200) {
    res.setHeader("Cache-Control", vaultReadCacheControl());
  }
  res.status(result.status).json(result.body);
}
