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

  describe("CORS preflight for the allowed origin", () => {
    async function preflight() {
      const server = await build();
      return server.inject({
        method: "OPTIONS",
        url: "/api/v1/vaults",
        headers: {
          origin: DEFAULT_ALLOWED_ORIGIN,
          "access-control-request-method": "GET",
        },
      });
    }

    it("answers with 204", async () => {
      expect((await preflight()).statusCode).toBe(204);
    });

    it("echoes the allowed origin", async () => {
      expect((await preflight()).headers["access-control-allow-origin"]).toBe(
        DEFAULT_ALLOWED_ORIGIN
      );
    });

    it("lists the allowed methods", async () => {
      expect(
        (await preflight()).headers["access-control-allow-methods"]
      ).toContain("POST");
    });

    it("still carries the security headers", async () => {
      const res = await preflight();
      for (const [name, value] of Object.entries(VERCEL_SECURITY_HEADERS)) {
        expect(res.headers[name], name).toBe(value);
      }
    });
  });
});
