import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { InMemoryRateLimitStore } from "@meridian/api-core";
import { policyForRequest, registerRateLimit } from "../rate-limit.js";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    submissionSourceAccount: vi.fn(() => undefined),
  };
});

/** Builds a server with the shared policy hook and a few probe routes. */
async function buildApp(options: {
  store?: InMemoryRateLimitStore;
  requireDistributed?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerRateLimit(app, options);
  app.get("/api/v1/vaults", async () => ({ ok: true }));
  app.post("/api/v1/tx/deposit", async () => ({ ok: true }));
  app.post("/api/v1/tx/submit", async () => ({ ok: true }));
  app.get("/api/v1/keepers/health", async () => ({ ok: true }));
  app.post("/api/v1/keepers/rebalance", async () => ({ ok: true }));
  app.get("/api/v1/admin/vaults", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("policyForRequest (#1287)", () => {
  const req = (url: string) =>
    ({ routeOptions: { url }, url }) as unknown as Parameters<
      typeof policyForRequest
    >[0];

  it("maps each route class to its own budget", () => {
    expect(policyForRequest(req("/api/v1/vaults"))).toBe("read");
    expect(policyForRequest(req("/api/v1/positions/abc"))).toBe("read");
    expect(policyForRequest(req("/api/v1/admin/vaults"))).toBe("admin");
    expect(policyForRequest(req("/api/v1/keepers/rebalance"))).toBe("keeper");
    expect(policyForRequest(req("/api/v1/tx/deposit"))).toBe("txBuild");
    expect(policyForRequest(req("/api/v1/tx/withdraw"))).toBe("txBuild");
  });

  it("gives submit the stricter submit budget, not the build budget", () => {
    expect(policyForRequest(req("/api/v1/tx/submit"))).toBe("txSubmit");
  });

  it("falls back to read for an unknown route", () => {
    expect(policyForRequest(req("/health"))).toBe("read");
  });
});

describe("registerRateLimit (#1287)", () => {
  it("advertises the read budget on a read route", async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("100");
    expect(res.headers["ratelimit-policy"]).toBe("100;w=60");
    await app.close();
  });

  it("applies the submit budget to submit and the build budget to build", async () => {
    const app = await buildApp({});
    const submit = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      payload: {},
    });
    const build = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      payload: {},
    });
    expect(submit.headers["ratelimit-limit"]).toBe("10");
    expect(build.headers["ratelimit-limit"]).toBe("30");
    await app.close();
  });

  it("does not let a burst of reads exhaust the submit budget", async () => {
    const app = await buildApp({ store: new InMemoryRateLimitStore() });
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "GET", url: "/api/v1/vaults" });
    }
    const submit = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      payload: {},
    });
    expect(submit.statusCode).not.toBe(429);
    expect(submit.headers["ratelimit-remaining"]).toBe("9");
    await app.close();
  });

  it("returns 429 with Retry-After once a route's budget is spent", async () => {
    const app = await buildApp({ store: new InMemoryRateLimitStore() });
    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/tx/submit",
        payload: {},
      });
    for (let i = 0; i < 10; i++) await send();
    const blocked = await send();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    await app.close();
  });

  it("returns 503 for a fail-closed route with no distributed store", async () => {
    const app = await buildApp({ requireDistributed: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: "RATE_LIMIT_BACKEND_UNAVAILABLE",
    });
    await app.close();
  });

  it("still serves read routes when only the in-memory store is available", async () => {
    const app = await buildApp({ requireDistributed: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
