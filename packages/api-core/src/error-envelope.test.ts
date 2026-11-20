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

  it("does not wrap successful responses", () => {
    expect(responseBody(200, { ok: true }, "req-3")).toEqual({ ok: true });
  });
});
