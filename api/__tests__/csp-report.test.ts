import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../v1/csp-report.js";
import { resetRateLimitForTesting } from "../_lib/middleware.js";

function fakeReq(
  method: string,
  body: string,
  headers: Record<string, string> = {
    "content-type": "application/csp-report",
  }
): VercelRequest {
  const req = Readable.from([Buffer.from(body)]);
  return Object.assign(req, {
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as VercelRequest;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

function fakeRes(): FakeRes & VercelResponse {
  const response: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
  };
  return Object.assign(response, {
    status(code: number) {
      response.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      response.body = payload;
      return this;
    },
    end() {
      response.ended = true;
      return this;
    },
    setHeader(key: string, value: string) {
      response.headers[key] = value;
      return this;
    },
  }) as unknown as FakeRes & VercelResponse;
}

beforeEach(() => resetRateLimitForTesting());
afterEach(() => vi.restoreAllMocks());

describe("CSP report endpoint", () => {
  it("handles preflight with the API's baseline security headers", async () => {
    const response = fakeRes();

    await handler(fakeReq("OPTIONS", ""), response);

    expect(response.statusCode).toBe(204);
    expect(response.ended).toBe(true);
    expect(response.headers["Content-Security-Policy"]).toBe(
      "default-src 'none'"
    );
    expect(response.headers["Cache-Control"]).toBe("no-store");
  });

  it("accepts a legacy report and logs only normalized, non-URL fields", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = fakeRes();
    const payload = JSON.stringify({
      "csp-report": {
        "document-uri": "https://example.test/private?token=secret",
        "blocked-uri": "https://tracker.test/pixel?user=secret",
        "effective-directive": "img-src https://tracker.test/pixel",
        disposition: "report",
        "status-code": 200,
      },
    });

    await handler(fakeReq("POST", payload), response);

    expect(response.statusCode).toBe(204);
    expect(response.ended).toBe(true);
    expect(response.headers["Content-Security-Policy"]).toBe(
      "default-src 'none'"
    );
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(info).toHaveBeenCalledWith("[csp-report]", {
      directive: "img-src",
      disposition: "report",
      statusCode: 200,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(info.mock.calls)).not.toContain("example.test");
  });

  it("accepts a bounded Reporting API batch", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = fakeRes();

    await handler(
      fakeReq(
        "POST",
        JSON.stringify([
          {
            type: "csp-violation",
            body: {
              effectiveDirective: "script-src-elem",
              disposition: "report",
              statusCode: 200,
            },
          },
        ]),
        { "content-type": "application/reports+json" }
      ),
      response
    );

    expect(response.statusCode).toBe(204);
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("[csp-report]", {
      directive: "script-src-elem",
      disposition: "report",
      statusCode: 200,
    });
  });

  it("rejects malformed, unsupported, and oversized payloads", async () => {
    const malformed = fakeRes();
    await handler(fakeReq("POST", "{"), malformed);
    expect(malformed.statusCode).toBe(400);

    const unsupported = fakeRes();
    await handler(
      fakeReq("POST", "{}", { "content-type": "text/plain" }),
      unsupported
    );
    expect(unsupported.statusCode).toBe(415);

    const oversized = fakeRes();
    await handler(fakeReq("POST", "x".repeat(8 * 1024 + 1)), oversized);
    expect(oversized.statusCode).toBe(413);

    const oversizedBatch = fakeRes();
    await handler(
      fakeReq(
        "POST",
        JSON.stringify(
          Array.from({ length: 6 }, () => ({
            type: "csp-violation",
            body: { effectiveDirective: "script-src" },
          }))
        ),
        { "content-type": "application/reports+json" }
      ),
      oversizedBatch
    );
    expect(oversizedBatch.statusCode).toBe(400);
  });

  it("rejects reports with unrecognized structure and non-POST methods", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const invalidReport = fakeRes();
    await handler(
      fakeReq("POST", JSON.stringify({ "csp-report": { "blocked-uri": "x" } })),
      invalidReport
    );
    expect(invalidReport.statusCode).toBe(400);
    expect(info).not.toHaveBeenCalled();

    const wrongMethod = fakeRes();
    await handler(fakeReq("GET", ""), wrongMethod);
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers.Allow).toBe("POST");
  });

  it("fails closed on deployed environments without distributed rate limiting", async () => {
    const previousEnvironment = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "preview";
    try {
      const response = fakeRes();
      await handler(
        fakeReq(
          "POST",
          JSON.stringify({
            "csp-report": { "effective-directive": "script-src" },
          })
        ),
        response
      );
      expect(response.statusCode).toBe(503);
      expect(response.body).toEqual({
        error:
          "Service Unavailable: Distributed rate limiting is required on deployed environments for this route.",
        code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
      });
    } finally {
      if (previousEnvironment === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previousEnvironment;
    }
  });
});
