import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { configRoute } from "../routes/config.js";

vi.mock("@meridian/api-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/api-core")>();
  return {
    ...actual,
    handleGetConfig: vi.fn(),
  };
});

import { CONFIG_CACHE_CONTROL, handleGetConfig } from "@meridian/api-core";

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(configRoute, { prefix: "/api/v1/config" });
  return app;
}

beforeAll(async () => {
  await buildApp().ready();
}, 60_000);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/config", () => {
  it("returns 200 with public config and Cache-Control header", async () => {
    const app = buildApp();
    const payload = {
      network: "testnet",
      passphrase: "Test SDF Network ; September 2015",
      contracts: {
        vault: "CAIQBVLBIUWQGE6DQUHDMZ2QWI7QP6KTCN7GP2BIZ6JZC4ES47JO4SSM",
        usdc: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
        musdc: "CCU7RWT246CODH2455WTSGUYKXRL3J4F5C2QXIEVCN7QHCRC4BAWGKV7",
        eurc: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
        blendPool: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
        defindexVault:
          "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN",
        defindexFactory:
          "CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32",
      },
      activeAdapter: {
        address: "CCKOKEMM7X6NQ6C6XXRRH6BPKLINDZBNHHCHY4YDR3VZNOLOQJCSZCEA",
        protocol: "blend",
      },
      degraded: false,
      supportedAssets: ["USDC", "EURC"],
      features: {
        defindexEnabled: true,
        musdcTrustlineRequired: false,
        riskAcknowledgementRequired: true,
      },
    };
    vi.mocked(handleGetConfig).mockResolvedValue({
      status: 200,
      body: payload,
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/config" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(CONFIG_CACHE_CONTROL);
    expect(res.json()).toEqual(payload);
    expect(handleGetConfig).toHaveBeenCalledTimes(1);
  });

  it("logs a warning and serves no-store when active adapter lookup fails", async () => {
    const app = buildApp();
    const logWarn = vi.spyOn(app.log, "warn");
    const err = new Error("rpc unavailable");
    vi.mocked(handleGetConfig).mockResolvedValue({
      status: 200,
      body: { network: "mainnet", activeAdapter: null, degraded: true },
      error: err,
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/config" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      network: "mainnet",
      activeAdapter: null,
      degraded: true,
    });
    expect(logWarn).toHaveBeenCalledWith(
      err,
      "[config] active adapter lookup failed"
    );
  });

  it("rejects non-GET methods with 405 and Allow: GET", async () => {
    const app = buildApp();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/v1/config" });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    }
    expect(handleGetConfig).not.toHaveBeenCalled();
  });
});
