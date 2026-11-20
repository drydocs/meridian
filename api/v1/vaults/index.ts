import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetVaults } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
  vaultReadCacheControl,
} from "../../_lib/middleware.js";

/**
 * GET /api/v1/vaults
 *
 * Contract is documented in the published OpenAPI schema (see docs/openapi.yaml).
 * When changing the response shape or status codes, update the schema and the
 * contract tests in the same change.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
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
