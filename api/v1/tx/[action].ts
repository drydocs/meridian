import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleSubmitRequest,
  handleAddTrustlineRequest,
} from "@meridian/api-core";
import {
  applyCors,
  checkRateLimit,
  getRequestId,
  sendResponse,
} from "../../_lib/middleware.js";

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
    console.error("[tx] rate limit check failed:", {
      requestId: getRequestId(req),
      error: err,
    });
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

  const result = await ACTIONS[action](req.body);
  if (result.error) {
    const cause = (result.error as { cause?: unknown } | undefined)?.cause;
    console.error(`[tx/${action}] failed:`, {
      requestId: getRequestId(req),
      error: result.error,
      ...(cause ? { cause } : {}),
    });
  }
  return sendResponse(req, res, result.status, result.body);
}
