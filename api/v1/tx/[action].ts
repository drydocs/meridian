import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleSubmitRequest,
  handleAddTrustlineRequest,
  handleQuoteRequest,
} from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  readJsonBody,
  sendResponse,
} from "../../_lib/middleware.js";
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
    return sendResponse(req, res, 503, {
      error: "Rate limiter unavailable; refusing to run",
    });
  }
  if (req.method !== "POST")
    return sendResponse(req, res, 405, { error: "Method not allowed" });

  const { action } = req.query;
  if (!isAction(action)) {
    return sendResponse(req, res, 404, { error: "Unknown action" });
  }

  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;

  const result = await ACTIONS[action](parsed.body);
  if (result.error) {
    logError("tx.failed", req, result.error, { action });
  }
  return sendResponse(req, res, result.status, result.body);
}
