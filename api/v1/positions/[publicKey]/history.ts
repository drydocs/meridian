import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleGetPositionHistory } from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../../_lib/middleware.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    if (!(await checkRateLimit(req, res))) return;
  } catch (err) {
    console.error("[positions/history] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }
  const { publicKey, days } = req.query as {
    publicKey: string;
    days?: string;
  };

  const result = await handleGetPositionHistory(publicKey, days);
  if (result.error) {
    console.error("[positions/history] error:", result.error);
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
