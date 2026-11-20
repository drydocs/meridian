import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";
import { buildApp } from "../app.js";

// The values `applySecurityHeaders` sets in api/_lib/middleware.ts for the
// deployed handlers. The local server must send the same ones.
const VERCEL_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "content-security-policy": "default-src 'none'",
} as const;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  app = await buildApp({
    enableRateLimit: false,
    allowedOrigin: DEFAULT_ALLOWED_ORIGIN,
  });
  await app.ready();
  return app;
}

describe("local Fastify security headers", () => {
  it("sends the Vercel security headers on a successful response", async () => {
    const server = await build();

    const res = await server.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    for (const [name, value] of Object.entries(VERCEL_SECURITY_HEADERS)) {
      expect(res.headers[name], name).toBe(value);
    }
  });

  it("sends the Vercel security headers on an error response", async () => {
    const server = await build();

    const res = await server.inject({ method: "GET", url: "/no-such-route" });

    expect(res.statusCode).toBe(404);
    for (const [name, value] of Object.entries(VERCEL_SECURITY_HEADERS)) {
      expect(res.headers[name], name).toBe(value);
    }
  });

  it("answers a CORS preflight for the allowed origin like the deployed handlers", async () => {
    const server = await build();

    const res = await server.inject({
      method: "OPTIONS",
      url: "/api/v1/vaults",
      headers: {
        origin: DEFAULT_ALLOWED_ORIGIN,
        "access-control-request-method": "GET",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      DEFAULT_ALLOWED_ORIGIN
    );
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["vary"]).toContain("Origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
