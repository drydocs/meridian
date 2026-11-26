import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, checkRateLimit } from "../_lib/middleware.js";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_REPORTS_PER_REQUEST = 5;

export const config = {
  api: {
    bodyParser: false,
  },
};

interface CspViolation {
  directive: string;
  disposition: "enforce" | "report";
  statusCode?: number;
}

class PayloadTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDirective(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const directive = value.trim().split(/\s+/, 1)[0];
  if (!directive) return undefined;
  return /^[a-z][a-z0-9-]{0,63}$/i.test(directive) ? directive : undefined;
}

function normalizeViolation(value: unknown): CspViolation | undefined {
  if (!isRecord(value)) return undefined;
  const directive = readDirective(
    value.effectiveDirective ??
      value["effective-directive"] ??
      value.violatedDirective ??
      value["violated-directive"]
  );
  if (!directive) return undefined;

  if (
    value.disposition !== undefined &&
    value.disposition !== "report" &&
    value.disposition !== "enforce"
  ) {
    return undefined;
  }
  const disposition = value.disposition === "enforce" ? "enforce" : "report";
  const rawStatusCode = value.statusCode ?? value["status-code"];
  const statusCode =
    typeof rawStatusCode === "number" &&
    Number.isInteger(rawStatusCode) &&
    rawStatusCode >= 0 &&
    rawStatusCode <= 599
      ? rawStatusCode
      : undefined;

  return {
    directive,
    disposition,
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function normalizeReports(value: unknown): CspViolation[] | undefined {
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > MAX_REPORTS_PER_REQUEST) {
      return undefined;
    }
    const violations: CspViolation[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || entry.type !== "csp-violation") return undefined;
      const violation = normalizeViolation(entry.body);
      if (!violation) return undefined;
      violations.push(violation);
    }
    return violations;
  }

  if (!isRecord(value)) return undefined;
  const legacyReport = value["csp-report"];
  if (legacyReport === undefined) return undefined;
  const violation = normalizeViolation(legacyReport);
  return violation ? [violation] : undefined;
}

async function readRequestBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (applyCors(req, res)) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Reports are not fund-moving, so this route is not strict, and it gets its
    // own bucket so violation reports never spend the budget of /tx/* routes.
    if (!(await checkRateLimit(req, res, { bucket: "csp-report" }))) return;
  } catch {
    console.error("[csp-report] rate limit check failed");
    return res.status(503).json({ error: "Report service unavailable" });
  }

  const [mediaType] =
    headerValue(req.headers["content-type"])?.split(";") ?? [];
  const contentType = mediaType?.trim().toLowerCase();
  if (
    contentType !== "application/csp-report" &&
    contentType !== "application/reports+json" &&
    contentType !== "application/json"
  ) {
    return res.status(415).json({ error: "Unsupported media type" });
  }

  const contentLength = Number(headerValue(req.headers["content-length"]));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Report payload too large" });
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return res.status(413).json({ error: "Report payload too large" });
    }
    console.error("[csp-report] request body read failed");
    return res.status(400).json({ error: "Invalid report payload" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: "Invalid report payload" });
  }

  const reports = normalizeReports(parsed);
  if (!reports) {
    return res.status(400).json({ error: "Invalid CSP report" });
  }

  for (const report of reports) {
    console.info("[csp-report]", report);
  }
  return res.status(204).end();
}
