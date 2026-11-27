import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ALLOWED_ORIGIN } from "@meridian/shared";

vi.mock("@meridian/shared/logger", () => ({ writeLog: vi.fn() }));

import { writeLog } from "@meridian/shared/logger";
import { buildApp, type BuildAppOptions } from "../app.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function build(options: BuildAppOptions): Promise<FastifyInstance> {
  app = await buildApp(options);
  await app.ready();
  return app;
}

async function preflightOrigin(server: FastifyInstance, origin: string) {
  const res = await server.inject({
    method: "OPTIONS",
    url: "/api/v1/vaults",
    headers: { origin, "access-control-request-method": "GET" },
  });
  return res.headers["access-control-allow-origin"];
}

describe("buildApp", () => {
  it("logs each request when a logger is configured", async () => {
    const server = await build({
      logger: { level: "silent" },
      enableRateLimit: false,
    });

    await server.inject({ method: "GET", url: "/health" });

    expect(writeLog).toHaveBeenCalledWith(
      "info",
      "http.request",
      expect.objectContaining({ method: "GET", route: "/health" })
    );
  });

  it("does not log requests without a logger", async () => {
    const server = await build({ enableRateLimit: false });

    await server.inject({ method: "GET", url: "/health" });

    expect(writeLog).not.toHaveBeenCalled();
  });

  it("allows the origin passed in the options", async () => {
    const server = await build({
      enableRateLimit: false,
      allowedOrigin: "https://options.example",
    });

    expect(await preflightOrigin(server, "https://options.example")).toBe(
      "https://options.example"
    );
  });

  it("falls back to ALLOWED_ORIGIN when no origin is passed", async () => {
    vi.stubEnv(
      "ALLOWED_ORIGIN",
      "https://env.example, https://preview.example"
    );
    const server = await build({ enableRateLimit: false });

    expect(await preflightOrigin(server, "https://env.example")).toBe(
      "https://env.example"
    );
    expect(await preflightOrigin(server, "https://preview.example")).toBe(
      "https://preview.example"
    );
    expect(
      await preflightOrigin(server, "https://other.example")
    ).toBeUndefined();
  });

  it("falls back to the default origin when ALLOWED_ORIGIN is unset", async () => {
    vi.stubEnv("ALLOWED_ORIGIN", undefined);
    const server = await build({ enableRateLimit: false });

    expect(await preflightOrigin(server, DEFAULT_ALLOWED_ORIGIN)).toBe(
      DEFAULT_ALLOWED_ORIGIN
    );
  });

  it("rate limits with the configured budget and answers 429 in the API error shape", async () => {
    const server = await build({
      rateLimitMax: 1,
      rateLimitTimeWindow: "1 minute",
    });

    const first = await server.inject({ method: "GET", url: "/health" });
    const second = await server.inject({ method: "GET", url: "/health" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({
      error: "Too many requests. Try again in a minute.",
    });
  });

  it("applies the default budget when none is configured", async () => {
    const server = await build({});

    const res = await server.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("100");
  });
});
