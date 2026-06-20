// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = any;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://usemeridian.vercel.app";

/**
 * Set CORS headers and handle preflight. Returns true when the request was a
 * preflight OPTIONS and has been fully handled — the caller should return
 * immediately in that case.
 */
export function applyCors(req: Req, res: Res): boolean {
  res.setHeader?.("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader?.("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader?.("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// In-memory rate limit: per-IP, 20 req / 60 s. Resets on cold start and is
// not shared across invocation instances. For a distributed limit use Upstash
// Redis or Vercel KV and swap this implementation.
const counts = new Map<string, { n: number; resetAt: number }>();
const LIMIT = 20;
const WINDOW_MS = 60_000;

function clientIp(req: Req): string {
  const fwd = req.headers?.["x-forwarded-for"];
  return (typeof fwd === "string" ? fwd.split(",")[0].trim() : null) ??
    req.socket?.remoteAddress ??
    "unknown";
}

/**
 * Check the per-IP rate limit. Returns true when the request is allowed.
 * Writes a 429 response and returns false when the limit is exceeded — the
 * caller should return immediately.
 */
export function checkRateLimit(req: Req, res: Res): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = counts.get(ip);

  if (!entry || now > entry.resetAt) {
    counts.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.n >= LIMIT) {
    res.status(429).json({ error: "Too many requests. Try again in a minute." });
    return false;
  }
  entry.n++;
  return true;
}
