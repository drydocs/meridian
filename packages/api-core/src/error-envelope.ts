import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-ID";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ErrorEnvelope {
  [key: string]: unknown;
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function createRequestId(candidate?: unknown): string {
  return isValidRequestId(candidate) ? candidate : randomUUID();
}

function defaultErrorCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  return status >= 500 ? "INTERNAL_ERROR" : "HTTP_ERROR";
}

export function toErrorEnvelope(
  status: number,
  body: unknown,
  requestId: string
): ErrorEnvelope {
  const source =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : undefined;
  const originalError = source?.error;
  const nestedError =
    originalError && typeof originalError === "object"
      ? (originalError as Record<string, unknown>)
      : undefined;
  const message =
    (typeof nestedError?.message === "string" && nestedError.message) ||
    (typeof originalError === "string" && originalError) ||
    (typeof source?.message === "string" && source.message) ||
    "Request failed";
  const code =
    (typeof nestedError?.code === "string" && nestedError.code) ||
    (typeof source?.code === "string" && source.code) ||
    defaultErrorCode(status);
  return {
    ...(source ?? {}),
    error: {
      code,
      message,
      requestId,
    },
  };
}

export function responseBody(
  status: number,
  body: unknown,
  requestId: string
): unknown {
  return status >= 400 ? toErrorEnvelope(status, body, requestId) : body;
}
