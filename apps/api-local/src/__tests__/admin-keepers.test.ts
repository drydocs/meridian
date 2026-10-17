import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { adminRoute } from "../routes/admin.js";
import { keepersRoute } from "../routes/keepers.js";

vi.mock("@meridian/api-core", () => ({
  createAdminChallenge: vi.fn(),
  verifyAdminChallenge: vi.fn(),
  handleGetVaultState: vi.fn(),
  handleGetKeeperHealth: vi.fn(),
}));

import {
  createAdminChallenge,
  verifyAdminChallenge,
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

describe("POST /api/v1/admin/challenge", () => {
  it("returns 200 with the challenge when the address is valid", async () => {
    const app = buildApp();
    const body = {
      challenge: "meridian-admin-v1:GADDR:nonce:1234567890",
      expiresAt: 1234567890,
    };
    vi.mocked(createAdminChallenge).mockResolvedValue({ status: 200, body });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/challenge",
      payload: { address: "GADDR" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(createAdminChallenge).toHaveBeenCalledWith("GADDR");
  });

  it("returns 400 when the address is invalid", async () => {
    const app = buildApp();
    vi.mocked(createAdminChallenge).mockResolvedValue({
      status: 400,
      body: { error: "Invalid wallet address" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/challenge",
      payload: { address: "not-a-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
    expect(createAdminChallenge).toHaveBeenCalledWith("not-a-key");
  });

  it("coerces a missing address field to an empty string", async () => {
    const app = buildApp();
    vi.mocked(createAdminChallenge).mockResolvedValue({
      status: 400,
      body: { error: "Invalid wallet address" },
    });

    // Send with no body at all so req.body is null/undefined (covers the ?? {} branch)
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/challenge",
    });
    expect(res.statusCode).toBe(400);
    expect(createAdminChallenge).toHaveBeenCalledWith("");
  });
});

describe("POST /api/v1/admin/verify", () => {
  it("returns 200 with a session token on valid proof", async () => {
    const app = buildApp();
    const body = { token: "hdr.pay.sig", expiresAt: 9999999999 };
    vi.mocked(verifyAdminChallenge).mockResolvedValue({ status: 200, body });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/verify",
      payload: {
        address: "GADDR",
        challenge: "meridian-admin-v1:GADDR:nonce:1234567890",
        signature: "AABBCC==",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(verifyAdminChallenge).toHaveBeenCalledWith({
      address: "GADDR",
      challenge: "meridian-admin-v1:GADDR:nonce:1234567890",
      signature: "AABBCC==",
    });
  });

  it("returns 401 when the proof is invalid", async () => {
    const app = buildApp();
    vi.mocked(verifyAdminChallenge).mockResolvedValue({
      status: 401,
      body: { error: "Invalid admin proof" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/verify",
      payload: { address: "GADDR", challenge: "bad", signature: "sig" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error");
  });

  it("coerces missing fields to empty strings", async () => {
    const app = buildApp();
    vi.mocked(verifyAdminChallenge).mockResolvedValue({
      status: 401,
      body: { error: "Invalid admin proof" },
    });

    // Send with no body at all so req.body is null/undefined (covers the ?? {} branch)
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/verify",
    });
    expect(res.statusCode).toBe(401);
    expect(verifyAdminChallenge).toHaveBeenCalledWith({
      address: "",
      challenge: "",
      signature: "",
    });
  });
});

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

  it("returns 404 for unregistered admin paths and non-GET methods", async () => {
    const app = buildApp();
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/admin/nope",
    });
    expect(unknown.statusCode).toBe(404);

    const post = await app.inject({
      method: "POST",
      url: "/api/v1/admin/vault-state",
    });
    expect(post.statusCode).toBe(404);
    expect(handleGetVaultState).not.toHaveBeenCalled();
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
