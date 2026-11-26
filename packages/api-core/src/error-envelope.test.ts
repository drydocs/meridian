import { describe, expect, it } from "vitest";
import {
  createRequestId,
  isValidRequestId,
  responseBody,
  toErrorEnvelope,
} from "./error-envelope";

describe("request IDs", () => {
  it("preserves a well-formed incoming ID", () => {
    expect(createRequestId("support-2026.11:abc")).toBe("support-2026.11:abc");
  });

  it("rejects IDs that could inject headers and generates a UUID", () => {
    expect(isValidRequestId("bad\r\nX-Injected: yes")).toBe(false);
    expect(createRequestId("bad\r\nX-Injected: yes")).toMatch(
      /^[0-9a-f-]{36}$/
    );
  });

  it("rejects non-string candidates", () => {
    expect(isValidRequestId(undefined)).toBe(false);
    expect(createRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("error envelope", () => {
  it("normalizes legacy error bodies while retaining safe details", () => {
    expect(
      toErrorEnvelope(404, { error: "vault not found", vaultId: "v1" }, "req-1")
    ).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "vault not found",
        requestId: "req-1",
      },
      vaultId: "v1",
    });
  });

  it("preserves an explicit error code", () => {
    expect(
      responseBody(
        503,
        { error: "Redis unavailable", code: "REDIS_DOWN" },
        "req-2"
      )
    ).toEqual({
      code: "REDIS_DOWN",
      error: {
        code: "REDIS_DOWN",
        message: "Redis unavailable",
        requestId: "req-2",
      },
    });
  });

  it("maps HTTP statuses to stable default error codes", () => {
    const cases = [
      [400, "VALIDATION_ERROR"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [405, "METHOD_NOT_ALLOWED"],
      [429, "RATE_LIMITED"],
      [503, "SERVICE_UNAVAILABLE"],
      [500, "INTERNAL_ERROR"],
      [418, "HTTP_ERROR"],
    ] as const;

    for (const [status, code] of cases) {
      expect(toErrorEnvelope(status, null, `req-${status}`).error.code).toBe(
        code
      );
    }
  });

  it("normalizes nested, top-level, and fallback messages and codes", () => {
    expect(
      toErrorEnvelope(
        400,
        {
          error: { message: "Nested failure", code: "NESTED" },
          message: "Outer",
          code: "OUTER",
        },
        "req-nested"
      ).error
    ).toEqual({
      code: "NESTED",
      message: "Nested failure",
      requestId: "req-nested",
    });

    expect(
      toErrorEnvelope(
        400,
        {
          error: { message: 7, code: 7 },
          message: "Top-level failure",
          code: "TOP_LEVEL",
        },
        "req-top"
      ).error
    ).toEqual({
      code: "TOP_LEVEL",
      message: "Top-level failure",
      requestId: "req-top",
    });

    expect(
      toErrorEnvelope(400, { error: "Legacy failure" }, "req-legacy").error
        .message
    ).toBe("Legacy failure");
    expect(
      toErrorEnvelope(
        400,
        { error: { message: "", code: "" }, message: "", code: "" },
        "req-default"
      ).error
    ).toEqual({
      code: "VALIDATION_ERROR",
      message: "Request failed",
      requestId: "req-default",
    });
  });

  it("does not wrap successful responses", () => {
    expect(responseBody(200, { ok: true }, "req-3")).toEqual({ ok: true });
  });
});
