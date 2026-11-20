import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositions } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  requireGetMethod,
} from "../../_lib/middleware.js";

/**
 * GET /api/v1/positions/{publicKey}
 *
 * Returns the positions held by the given public key.
 * The response contract is documented in the OpenAPI schema for /api/v1.
 * When this handler's status codes or response body shape change, update the
 * schema and the contract tests together (see the API contribution guide).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[positions] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }
  const { publicKey } = req.query as { publicKey: string };

  const result = await handleGetPositions(publicKey);
  if (result.error) {
    console.error("[positions] error:", result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
