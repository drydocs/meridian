import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("../_lib/middleware.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/middleware.js")>(
    "../_lib/middleware.js"
  );
  return {
    ...actual,
    checkRateLimit: vi.fn(
      async (...args: Parameters<typeof actual.checkRateLimit>) =>
        actual.checkRateLimit(...args)
    ),
  };
});

vi.mock("@meridian/api-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/api-core")>();
  return {
    ...actual,
    handleGetConfig: vi.fn(async () => ({
      status: 200,
      body: {
        network: "mainnet",
        passphrase: "Public Global Stellar Network ; September 2015",
        contracts: {
          vault: "CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ",
          usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          musdc: "CAEJJPN73VOEWUVCXCXMIXOHMFLUXAYVFMCTCJHQFI5R2NIB2S5YTOFL",
          eurc: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
          blendPool: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
          defindexVault: null,
          defindexFactory: null,
        },
        activeAdapter: {
          address: "CBNKERYAG7VZNBH2V3TF5JBXLD3MXLVQW5GG4AO445EUDCPKP4D2DDP2",
          protocol: "blend",
        },
        degraded: false,
        supportedAssets: ["USDC", "EURC"],
        features: {
          defindexEnabled: false,
          musdcTrustlineRequired: false,
          riskAcknowledgementRequired: true,
        },
      },
    })),
  };
});

import { CONFIG_CACHE_CONTROL, handleGetConfig } from "@meridian/api-core";
import {
  checkRateLimit,
  resetRateLimitForTesting,
} from "../_lib/middleware.js";
import configHandler from "../v1/config.js";

function fakeReq(obj: Record<string, unknown>): VercelRequest {
  return {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...obj,
  } as unknown as VercelRequest;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

function fakeRes(): FakeRes & VercelResponse {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
  };
  return Object.assign(r, {
    status(code: number) {
      r.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      r.body = payload;
      return this;
    },
    end() {
      r.ended = true;
      return this;
    },
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
  }) as unknown as FakeRes & VercelResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/config", () => {
  it("returns 200 with public config and short Cache-Control header", async () => {
    const res = fakeRes();
    await configHandler(fakeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe(CONFIG_CACHE_CONTROL);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.body).toMatchObject({
      network: "mainnet",
      supportedAssets: ["USDC", "EURC"],
      activeAdapter: { protocol: "blend" },
      degraded: false,
    });
  });

  it("sets Cache-Control: no-store when active adapter lookup degrades", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("rpc unavailable");
    vi.mocked(handleGetConfig).mockResolvedValueOnce({
      status: 200,
      body: { network: "mainnet", activeAdapter: null, degraded: true },
      error: err,
    });

    const res = fakeRes();
    await configHandler(fakeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toEqual({
      network: "mainnet",
      activeAdapter: null,
      degraded: true,
    });
    expect(errSpy).toHaveBeenCalledWith(
      "[config] active adapter lookup failed:",
      err
    );
  });

  it("handles OPTIONS preflight with 204", async () => {
    const res = fakeRes();
    await configHandler(fakeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(handleGetConfig).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods with 405 and Allow: GET", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = fakeRes();
      await configHandler(fakeReq({ method }), res);
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    }
    expect(handleGetConfig).not.toHaveBeenCalled();
  });

  it("returns 503 when rate limiter check throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error("redis down"));

    const res = fakeRes();
    await configHandler(fakeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "Rate limiter unavailable; refusing to run",
    });
    expect(handleGetConfig).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it("returns early when rate limit blocks the request", async () => {
    vi.mocked(checkRateLimit).mockImplementationOnce(async (_req, res) => {
      res
        .status(429)
        .json({ error: "Too many requests. Try again in a minute." });
      return false;
    });

    const res = fakeRes();
    await configHandler(fakeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(429);
    expect(handleGetConfig).not.toHaveBeenCalled();
  });
});

describe("OpenAPI documentation", () => {
  it("documents GET /api/v1/config in docs/openapi.yaml", () => {
    const specPath = resolve(__dirname, "../../docs/openapi.yaml");
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain("openapi:");
    expect(spec).toContain("/api/v1/config:");
    expect(spec).toContain("operationId: getPublicConfig");
    expect(spec).toContain("PublicConfigResponse");
    expect(spec).toContain("Cache-Control:");
    expect(spec).toContain("degraded:");
  });
});
