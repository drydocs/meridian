import { randomUUID } from "node:crypto";
import { sanitizeTxError } from "./utils";

export type LogLevel = "info" | "warn" | "error";
type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
};

const REDACTED = "[REDACTED]";
const SECRET_KEY =
  /(secret|token|password|private|xdr|authorization|cookie|mnemonic|seed|credential)/i;
const ADDRESS_KEY = /(public.?key|wallet|address)/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return candidate && REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

function redactCause(value: unknown, depth = 0): unknown {
  if (depth > 5) return REDACTED;
  if (value instanceof Error) return errorDetails(value, depth);
  if (typeof value === "string") {
    return sanitizeTxError(new Error(value), REDACTED);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCause(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? REDACTED : redactCause(child, depth + 1),
      ])
    );
  }
  return value;
}

function errorDetails(error: Error, depth = 0): Record<string, unknown> {
  // The shared package targets ES2020, where `Error.cause` is not in the lib
  // typings even though newer runtimes provide it.
  const cause = (error as Error & { cause?: unknown }).cause;
  return {
    name: error.name,
    message: sanitizeTxError(error, "Unexpected error"),
    ...(error.stack
      ? {
          stack: sanitizeTxError(new Error(error.stack), "Error stack omitted"),
        }
      : {}),
    ...(cause !== undefined ? { cause: redactCause(cause, depth + 1) } : {}),
  };
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
  else console.info(line);
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
      ? errorDetails(error)
      : { message: sanitizeTxError(error, "Unexpected error") };
  log("error", event, req, { ...context, error: detail });
}
