import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetConfig } from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  configCacheControl,
  requireGetMethod,
} from "../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (requireGetMethod(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[config] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }

  const result = await handleGetConfig();
  if (result.error) {
    console.error("[config] active adapter lookup failed:", result.error);
  }
  res.setHeader(
    "Cache-Control",
    configCacheControl(result.error !== undefined)
  );
  res.status(result.status).json(result.body);
}
