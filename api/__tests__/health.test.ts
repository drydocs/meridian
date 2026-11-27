import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../_lib/middleware.js", () => ({
  applyCors: vi.fn(() => false),
  checkRateLimit: vi.fn(async () => true),
  sendResponse: vi.fn(
    (_req: unknown, res: VercelResponse, status: number, body: unknown) =>
      res.status(status).json(body)
  ),
}));
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("@meridian/api-core", () => ({
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
}));

import { handleGetLiveness, handleGetReadiness } from "@meridian/api-core";
import healthHandler from "../v1/health/[action]";

function fakeResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response;
}

function request(action: string, method = "GET") {
  return { method, query: { action } } as unknown as VercelRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("Vercel health adapters", () => {
  it("serves liveness without invoking readiness", async () => {
    const res = fakeResponse();
    await healthHandler(request("live"), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "healthy", network: "testnet" });
    expect(handleGetLiveness).toHaveBeenCalledOnce();
    expect(handleGetReadiness).not.toHaveBeenCalled();
  });

  it("maps readiness status and schema to the HTTP response", async () => {
    const res = fakeResponse();
    await healthHandler(request("ready"), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      status: "not_ready",
      network: "testnet",
      dependencies: { upstashRedis: { status: "unhealthy" } },
    });
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("rejects non-GET requests without calling core handlers", async () => {
    const res = fakeResponse();
    await healthHandler(
      request("live", "POST"),
      res as unknown as VercelResponse
    );
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
    expect(handleGetLiveness).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown health actions", async () => {
    const res = fakeResponse();
    await healthHandler(request("missing"), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(404);
    expect(handleGetReadiness).not.toHaveBeenCalled();
  });
});
