import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleSubmitRequest,
  handleAddTrustlineRequest,
  type RateLimitPolicyName,
} from "@meridian/api-core";
import { applyCors, checkRateLimit } from "../../_lib/middleware.js";

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

/**
 * Submit gets its own stricter budget because it is the only action that
 * spends real fees and mutates on-chain state; the three build actions share
 * the looser build budget.
 */
function txPolicyFor(action: unknown): RateLimitPolicyName {
  return action === "submit" ? "txSubmit" : "txBuild";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { action } = req.query;
  if (applyCors(req, res)) return;
  try {
    if (!(await checkRateLimit(req, res, { policy: txPolicyFor(action) })))
      return;
  } catch (err) {
    console.error("[tx] rate limit check failed:", err);
    return res
      .status(503)
      .json({ error: "Rate limiter unavailable; refusing to run" });
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (!isAction(action)) {
    return res.status(404).json({ error: "Unknown action" });
  }

  const result = await ACTIONS[action](req.body);
  if (result.error) {
    const cause = (result.error as { cause?: unknown } | undefined)?.cause;
    console.error(
      `[tx/${action}] failed:`,
      result.error,
      cause ? { cause } : ""
    );
  }
  res.status(result.status).json(result.body);
}
