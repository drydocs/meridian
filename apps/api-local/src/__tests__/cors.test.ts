import { describe, it, expect, vi, afterEach } from "vitest";
import { buildApp } from "../app.js";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  KNOWN_POOLS: {
    testnet: {},
  },
  consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("CORS multiple origins", () => {
  const savedAllowedOrigin = process.env.ALLOWED_ORIGIN;

  afterEach(() => {
    if (savedAllowedOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = savedAllowedOrigin;
  });

  it("accepts a request from an allowed origin", async () => {
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
      allowedOrigin: "https://app1.com,https://app2.com",
    });

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app2.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app2.com"
    );
    expect(res.headers["vary"]).toBe("Origin");
  });

  it("rejects a request from a disallowed origin", async () => {
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
      allowedOrigin: "https://app1.com,https://app2.com",
    });

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.com" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty("message", "Not allowed by CORS");
  });

  it("allows requests with no origin header", async () => {
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
      allowedOrigin: "https://app1.com",
    });

    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
  });

  it("handles preflight OPTIONS requests for allowed origins", async () => {
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
      allowedOrigin: "https://app1.com,https://app2.com",
    });

    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://app1.com",
        "access-control-request-method": "GET",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app1.com"
    );
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("includes Vary: Origin header for proper caching", async () => {
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
      allowedOrigin: "https://app1.com,https://app2.com",
    });

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app1.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["vary"]).toBe("Origin");
  });

  it("throws an error when ALLOWED_ORIGIN contains wildcards", async () => {
    await expect(
      buildApp({
        logger: false,
        enableRateLimit: false,
        allowedOrigin: "https://*.example.com",
      })
    ).rejects.toThrow(
      'ALLOWED_ORIGIN contains wildcard "https://*.example.com". Wildcards are not permitted.'
    );
  });

  it("throws an error when ALLOWED_ORIGIN is a single wildcard", async () => {
    await expect(
      buildApp({
        logger: false,
        enableRateLimit: false,
        allowedOrigin: "*",
      })
    ).rejects.toThrow(
      'ALLOWED_ORIGIN contains wildcard "*". Wildcards are not permitted.'
    );
  });

  it("parses and trims comma-separated origins correctly", async () => {
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
      allowedOrigin: " https://app1.com , https://app2.com , https://app3.com ",
    });

    const res1 = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app1.com" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers["access-control-allow-origin"]).toBe(
      "https://app1.com"
    );

    const res2 = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app3.com" },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["access-control-allow-origin"]).toBe(
      "https://app3.com"
    );
  });

  it("uses the default origin when ALLOWED_ORIGIN is not provided", async () => {
    delete process.env.ALLOWED_ORIGIN;
    const app = await buildApp({
      logger: false,
      enableRateLimit: false,
    });

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://usemeridian.vercel.app" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://usemeridian.vercel.app"
    );
  });
});
