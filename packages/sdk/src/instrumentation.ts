import type { MeridianError } from "./errors.js";

export const REDACTED = "[REDACTED]";

/** Event fields are already sanitized by the time a hook sees them. */
export interface RequestEvent {
  /** SDK method name, e.g. `deposit` or `getPosition`. */
  operation: string;
  /** Sanitized call parameters (bigints rendered as strings). */
  params: Readonly<Record<string, unknown>>;
  /** 1-based attempt number. */
  attempt: number;
}

export interface RequestSuccessEvent extends RequestEvent {
  durationMs: number;
}

export interface RequestErrorEvent extends RequestEvent {
  durationMs: number;
  error: SanitizedError;
}

export interface RetryEvent extends RequestEvent {
  delayMs: number;
  error: SanitizedError;
}

export interface SanitizedError {
  name: string;
  code: MeridianError["code"];
  retryable: boolean;
  /** First line of the message, with secrets and URLs scrubbed. */
  message: string;
}

/**
 * Optional telemetry callbacks. Hooks are observers: a hook that throws or
 * rejects is ignored and never changes the outcome of an SDK call.
 */
export interface InstrumentationHooks {
  onRequestStart?: (event: RequestEvent) => void | Promise<void>;
  onRequestSuccess?: (event: RequestSuccessEvent) => void | Promise<void>;
  onRequestError?: (event: RequestErrorEvent) => void | Promise<void>;
  onRetry?: (event: RetryEvent) => void | Promise<void>;
}

const SENSITIVE_KEY =
  /secret|seed|private|mnemonic|passphrase|password|token|api[-_]?key|auth|signature|signer|xdr|credential|cookie/i;
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_BASE64 = /\b[A-Za-z0-9+/]{120,}={0,2}/g;

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Keep only the origin: userinfo, path segments and query strings are
    // where RPC providers put API keys.
    return `${url.protocol}//${url.host}/${REDACTED}`;
  } catch {
    return REDACTED;
  }
}

/** Scrub secrets, credentials and URLs out of free text. */
export function redactString(text: string): string {
  return text
    .replace(URL_PATTERN, (m) => redactUrl(m))
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(STELLAR_SECRET, REDACTED)
    .replace(LONG_BASE64, REDACTED);
}

/**
 * Deep-copy `value` with sensitive material removed: values under sensitive
 * keys, Stellar secret seeds, bearer tokens, URL credentials/paths/queries
 * and long base64 blobs (XDR). Bigints become strings; cycles and depth over
 * 6 are cut off.
 */
export function redact(
  value: unknown,
  depth = 0,
  seen = new WeakSet()
): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    return typeof value === "function" || typeof value === "symbol"
      ? undefined
      : value;
  }
  if (seen.has(value) || depth > 6) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

export function sanitizeError(error: MeridianError): SanitizedError {
  const first = error.message.split("\n")[0]?.trim() ?? "";
  return {
    name: error.name,
    code: error.code,
    retryable: error.retryable,
    message: redactString(first),
  };
}

/** Invoke a hook, swallowing both sync throws and async rejections. */
export function safeCall<E>(
  hook: ((event: E) => void | Promise<void>) | undefined,
  event: E
): void {
  if (!hook) return;
  try {
    const result = hook(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Observers must not affect SDK behaviour.
  }
}
