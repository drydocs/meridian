import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleSubmitRequest,
  handleAddTrustlineRequest,
  handleQuoteRequest,
} from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";
import { logError } from "../../_lib/logger.js";

// Consolidated from four separate files (deposit/withdraw/submit/add-trustline)
// to stay under Vercel's per-deployment Serverless Functions cap. URL paths
// are unchanged: Vercel's [action].ts dynamic segment routes
// /api/v1/tx/deposit, /api/v1/tx/withdraw, etc. to this one file with
// req.query.action set accordingly.
const ACTIONS = {
  deposit: handleDepositRequest,
  withdraw: handleWithdrawRequest,
  submit: handleSubmitRequest,
  "add-trustline": handleAddTrustlineRequest,
  quote: handleQuoteRequest,
} as const;

type Action = keyof typeof ACTIONS;

function isAction(value: unknown): value is Action {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ACTIONS, value)
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res, { strict: true }))) return;
  } catch (err) {
    logError("tx.rate_limit_failed", req, err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.query;
  if (!isAction(action)) {
    return res.status(404).json({ error: "Unknown action" });
  }

  const result = await ACTIONS[action](req.body);
  if (result.error) {
    logError("tx.failed", req, result.error, { action });
  }
  res.status(result.status).json(result.body);
}
