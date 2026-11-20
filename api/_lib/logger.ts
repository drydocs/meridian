import { randomUUID } from "node:crypto";
export type LogLevel = "info" | "warn" | "error";
type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
};

const REDACTED = "[REDACTED]";
const SECRET_KEY =
  /(secret|token|password|private|signed.?xdr|authorization|cookie|mnemonic|seed|credential)/i;
const ADDRESS_KEY = /(public.?key|wallet|address)/i;

function shortAddress(value: string): string {
  if (value.length < 12) return REDACTED;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string") {
    return ADDRESS_KEY.test(key) ? shortAddress(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ])
    );
  }
  return value;
}

export function requestId(req: RequestLike | undefined): string {
  const raw = req?.headers?.["x-request-id"];
  return (Array.isArray(raw) ? raw[0] : raw) || randomUUID();
}

export function writeLog(
  level: LogLevel,
  event: string,
  context: Record<string, unknown> = {}
): void {
  const record = redact({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...context,
  }) as Record<string, unknown>;
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function log(
  level: LogLevel,
  event: string,
  req: RequestLike | undefined,
  context: Record<string, unknown> = {}
): void {
  writeLog(level, event, { requestId: requestId(req), ...context });
}

export function logError(
  event: string,
  req: RequestLike | undefined,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  const detail =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
  log("error", event, req, { ...context, error: detail });
}
