import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { healthRoute } from "../routes/health.js";
import { buildApp as buildServerApp } from "../app.js";

vi.mock("@meridian/api-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/api-core")>();
  return {
    ...actual,
    handleGetLiveness: vi.fn(() => ({
      status: 200,
      body: {
        status: "healthy",
        network: "testnet",
        version: "1.2.3",
        build: { version: "1.2.3", commit: "abc123", deployment: "preview" },
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    })),
    handleGetReadiness: vi.fn(async () => ({
      status: 503,
      body: {
        status: "not_ready",
        network: "testnet",
        version: "1.2.3",
        build: { version: "1.2.3", commit: "abc123", deployment: "preview" },
        dependencies: {
          sorobanRpc: { status: "healthy", details: { latestLedger: 42 } },
          upstashRedis: { status: "unhealthy", error: "timeout" },
          positionSnapshots: {
            status: "healthy",
            details: { mode: "persistent", trackedUsers: 0 },
          },
          buildMetadata: { status: "healthy" },
        },
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    })),
  };
});

import { handleGetLiveness, handleGetReadiness } from "@meridian/api-core";

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(healthRoute, { prefix: "/api/v1/health" });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("Fastify health adapters", () => {
  it("registers liveness and readiness through buildApp", async () => {
    const app = await buildServerApp();

    const live = await app.inject({
      method: "GET",
      url: "/api/v1/health/live",
    });
    const ready = await app.inject({
      method: "GET",
      url: "/api/v1/health/ready",
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: "healthy" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "not_ready" });
    await app.close();
  });

  it("serves liveness without invoking readiness", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "healthy", network: "testnet" });
    expect(handleGetLiveness).toHaveBeenCalledOnce();
    expect(handleGetReadiness).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps readiness status and schema to the HTTP response", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health/ready",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "not_ready",
      network: "testnet",
      dependencies: { upstashRedis: { status: "unhealthy" } },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("rejects non-GET requests without calling a health handler", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/health/live",
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    expect(handleGetLiveness).not.toHaveBeenCalled();
    await app.close();
  });
});
