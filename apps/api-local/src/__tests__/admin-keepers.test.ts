import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { adminRoute } from "../routes/admin.js";
import { keepersRoute } from "../routes/keepers.js";

vi.mock("@meridian/api-core", () => ({
  handleGetAdminHistory: vi.fn(),
  handleGetVaultState: vi.fn(),
  handleGetKeeperHealth: vi.fn(),
  createAdminChallenge: vi.fn(),
  verifyAdminChallenge: vi.fn(),
}));

import {
  handleGetAdminHistory,
  handleGetVaultState,
  handleGetKeeperHealth,
} from "@meridian/api-core";

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(adminRoute, { prefix: "/api/v1/admin" });
  app.register(keepersRoute, { prefix: "/api/v1/keepers" });
  return app;
}

// Fastify's first ready() is slow on a cold, loaded machine; pay that cost in
// a hook with a generous timeout rather than in the first test's 5s budget.
beforeAll(async () => {
  await buildApp().ready();
}, 60_000);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/admin/vault-state", () => {
  it("returns 200 with the coordinator vault state", async () => {
    const app = buildApp();
    const state = {
      protocol: "blend",
      adapterId: "ADAPTER_ID",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    };
    vi.mocked(handleGetVaultState).mockResolvedValue({
      status: 200,
      body: state,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/vault-state",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(state);
    expect(handleGetVaultState).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when no coordinator vault is configured", async () => {
    const app = buildApp();
    vi.mocked(handleGetVaultState).mockResolvedValue({
      status: 404,
      body: { error: "No Meridian coordinator vault configured" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/vault-state",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 503 and logs when the on-chain read fails", async () => {
    const app = buildApp();
    const logError = vi.spyOn(app.log, "error");
    const err = new Error("rpc unavailable");
    vi.mocked(handleGetVaultState).mockResolvedValue({
      status: 503,
      body: { error: "Failed to read vault state" },
      error: err,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/vault-state",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Failed to read vault state" });
    expect(logError).toHaveBeenCalledWith(
      err,
      "[admin] failed to read vault state"
    );
  });

  it("does not log an error on success", async () => {
    const app = buildApp();
    const logError = vi.spyOn(app.log, "error");
    vi.mocked(handleGetVaultState).mockResolvedValue({
      status: 200,
      body: {},
    });

    await app.inject({ method: "GET", url: "/api/v1/admin/vault-state" });
    expect(logError).not.toHaveBeenCalled();
  });

  it("returns 404 for unregistered admin paths", async () => {
    const app = buildApp();
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/admin/nope",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("rejects non-GET admin methods with 405", async () => {
    const app = buildApp();
    for (const url of [
      "/api/v1/admin/vault-state",
      "/api/v1/admin/history?vaultId=meridian-usdc",
    ]) {
      const post = await app.inject({ method: "POST", url });
      expect(post.statusCode).toBe(405);
      expect(post.headers.allow).toBe("GET");
    }
    expect(handleGetVaultState).not.toHaveBeenCalled();
    expect(handleGetAdminHistory).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/admin/history", () => {
  it("returns admin actions for the requested vault", async () => {
    const app = buildApp();
    const actions = [{ action: "pause", ledger: 42 }];
    vi.mocked(handleGetAdminHistory).mockResolvedValue({
      status: 200,
      body: { vaultId: "meridian-usdc", actions },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/history?vaultId=meridian-usdc",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ vaultId: "meridian-usdc", actions });
    // The handler is called with the vaultId and the authorization header
    // (undefined when no Authorization header is present in the request).
    expect(handleGetAdminHistory).toHaveBeenCalledWith(
      "meridian-usdc",
      undefined
    );
  });

  it("returns 400 without calling the handler when vaultId is missing", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/history",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "vaultId is required" });
    expect(handleGetAdminHistory).not.toHaveBeenCalled();
  });

  it("returns the handler status and logs an error", async () => {
    const app = buildApp();
    const logError = vi.spyOn(app.log, "error");
    const err = new Error("horizon unavailable");
    vi.mocked(handleGetAdminHistory).mockResolvedValue({
      status: 500,
      body: { error: "Failed to fetch admin history" },
      error: err,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/history?vaultId=meridian-usdc",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Failed to fetch admin history" });
    expect(logError).toHaveBeenCalledWith(
      err,
      "[admin] failed to read admin history"
    );
  });
});

describe("GET /api/v1/keepers/health", () => {
  it("returns 200 with the keeper health report", async () => {
    const app = buildApp();
    const body = {
      keepers: [
        { id: "accrual", intervalMs: 1, lastSuccessMs: 5, healthy: true },
        { id: "migration", intervalMs: 2, lastSuccessMs: null, healthy: false },
      ],
      checkedAt: "2026-01-01T00:00:00.000Z",
    };
    vi.mocked(handleGetKeeperHealth).mockResolvedValue({ status: 200, body });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/keepers/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(handleGetKeeperHealth).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and logs when reading keeper health fails", async () => {
    const app = buildApp();
    const logError = vi.spyOn(app.log, "error");
    const err = new Error("store unreachable");
    vi.mocked(handleGetKeeperHealth).mockResolvedValue({
      status: 500,
      body: { error: "Failed to read keeper health" },
      error: err,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/keepers/health",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Failed to read keeper health" });
    expect(logError).toHaveBeenCalledWith(
      err,
      "[keepers] failed to read keeper health"
    );
  });

  it("does not log an error on success", async () => {
    const app = buildApp();
    const logError = vi.spyOn(app.log, "error");
    vi.mocked(handleGetKeeperHealth).mockResolvedValue({
      status: 200,
      body: { keepers: [] },
    });

    await app.inject({ method: "GET", url: "/api/v1/keepers/health" });
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not expose accrue/rebalance and rejects non-GET methods", async () => {
    const app = buildApp();
    for (const url of ["/api/v1/keepers/accrue", "/api/v1/keepers/rebalance"]) {
      const res = await app.inject({ method: "POST", url });
      expect(res.statusCode).toBe(404);
    }
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/keepers/health",
    });
    expect(post.statusCode).toBe(404);
    expect(handleGetKeeperHealth).not.toHaveBeenCalled();
  });
});
