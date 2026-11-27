import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildApp } from "@meridian/api-local/app";
import type { FastifyInstance } from "fastify";
import { resetRateLimitForTesting } from "../_lib/middleware.js";

// Deterministic test fixtures for Soroban RPC, ledger data, and vault states
const FIXTURE_PUBLIC_KEY =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const FIXTURE_VAULTS = [
  {
    id: "meridian-usdc",
    name: "Meridian",
    protocol: "meridian",
    label: "USDC Vault",
    apy: 5.25,
    tvl: 1234567,
    userBalance: 0,
    riskLevel: "safe",
  },
  {
    id: "blend-usdc-fixed",
    name: "Blend Capital",
    protocol: "blend",
    label: "Fixed Pool",
    apy: 4.8,
    tvl: 543210,
    userBalance: 0,
    riskLevel: "safe",
  },
];

const FIXTURE_POSITIONS = [
  {
    vaultId: "meridian-usdc",
    shares: 1000,
    deposited: 1000,
    earned: 25,
    entryTime: 1700000000,
  },
];

const FIXTURE_HISTORY_SNAPSHOTS = [
  { timestamp: "2026-11-01T00:00:00.000Z", totalUsd: 1000 },
  { timestamp: "2026-11-02T00:00:00.000Z", totalUsd: 1025 },
];

const FIXTURE_COORDINATOR_STATE = {
  protocol: "meridian",
  adapterId: "CADAPTER0000000000000000000000000000000000000000000000000001",
  totalShares: 1000,
  totalAssets: 1050,
  paused: false,
};

const FIXTURE_ADMIN_ACTIONS = [
  {
    txHash: "0000000000000000000000000000000000000000000000000000000000000001",
    ledger: 100,
    createdAt: "2026-11-18T12:00:00.000Z",
    action: "rebalance",
    details: "Rebalanced to Blend pool",
  },
];

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    ContractSimulationError: actual.ContractSimulationError,
    MissingTrustlineError: actual.MissingTrustlineError,
    fetchAllVaults: vi.fn(async () => FIXTURE_VAULTS),
    fetchVaultsWithCache: vi.fn(async () => ({
      vaults: FIXTURE_VAULTS,
      cached: false,
    })),
    selectBestVault: vi.fn(() => FIXTURE_VAULTS[0]),
    isVaultCacheWarm: vi.fn(() => true),
    getLatestLedgerSequence: vi.fn(async () => 1_000_000),
    resolvePositions: vi.fn(async () => FIXTURE_POSITIONS),
    getPositionHistory: vi.fn(async () => FIXTURE_HISTORY_SNAPSHOTS),
    loadPositionSnapshotStore: vi.fn(() => ({ track: vi.fn(async () => {}) })),
    recordPositionSnapshot: vi.fn(async () => true),
    buildDepositTx: vi.fn(async () => ({
      xdr: "AAAA_CONFORMANCE_DEPOSIT_XDR",
      fee: "100",
    })),
    buildWithdrawTx: vi.fn(async () => ({
      xdr: "AAAA_CONFORMANCE_WITHDRAW_XDR",
      fee: "100",
    })),
    // Prices the slippage floor when a build request omits its minimum.
    quoteVaultAction: vi.fn(async ({ action }: { action: string }) => ({
      action,
      fee: "0",
      ledger: 1,
      recommendedMinimum: action === "deposit" ? "9.9" : "4.9",
      slippageBps: 50,
    })),
    buildAddTrustlineTx: vi.fn(async () => ({
      xdr: "AAAA_CONFORMANCE_TRUSTLINE_XDR",
    })),
    submitTx: vi.fn(async () => ({
      hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })),
    assertRequiredTrustlines: vi.fn().mockResolvedValue(undefined),
    fetchCoordinatorState: vi.fn(async () => FIXTURE_COORDINATOR_STATE),
    getAdminActionHistory: vi.fn(async () => FIXTURE_ADMIN_ACTIONS),
    loadKeeperHeartbeatStore: vi.fn(() => ({})),
    getKeeperHeartbeat: vi.fn(async () => 1700000000000),
    isKeeperHealthy: vi.fn(() => true),
    KEEPER_SCHEDULE_MS: { accrual: 15 * 60_000, migration: 60 * 60_000 },
    KNOWN_POOLS: {
      testnet: {
        "meridian-usdc": {
          id: "meridian-usdc",
          name: "Meridian",
          protocol: "meridian",
          label: "USDC Vault",
          contractId:
            "CBOE7JPROCMUKQ4NJWPKCLBBQGHLTGV4X3463DHK4D7KX6KWXGZETAJL",
          assetId: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
          asset: "USDC",
        },
      },
      mainnet: {
        "meridian-usdc": {
          id: "meridian-usdc",
          name: "Meridian",
          protocol: "meridian",
          label: "USDC Vault",
          contractId:
            "CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ",
          assetId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          asset: "USDC",
        },
      },
    },
  };
});

import txHandler from "../v1/tx/[action].js";
import vaultsHandler from "../v1/vaults/index.js";
import vaultDetailHandler from "../v1/vaults/[vaultId].js";
import positionsHandler from "../v1/positions/[publicKey].js";
import positionHistoryHandler from "../v1/positions/[publicKey]/history.js";
import keepersHandler from "../v1/keepers/[action].js";
import adminHandler from "../v1/admin/[resource].js";

interface ConformanceRequest {
  method: "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  ip?: string;
}

interface NormalizedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function normalizeBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(normalizeBody);

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "statusCode" && (body as Record<string, unknown>)["error"]) {
      continue;
    }
    // Each request gets its own ID, so only its presence is compared.
    if (key === "requestId" && typeof value === "string") {
      normalized[key] = "[REQUEST_ID]";
    } else if (
      (key === "updatedAt" || key === "checkedAt") &&
      typeof value === "string" &&
      !isNaN(Date.parse(value))
    ) {
      normalized[key] = "[ISO_TIMESTAMP]";
    } else {
      normalized[key] = normalizeBody(value);
    }
  }
  return normalized;
}

function parseUrl(rawUrl: string): {
  pathname: string;
  query: Record<string, string>;
} {
  const [pathname, search] = rawUrl.split("?");
  const query: Record<string, string> = {};
  if (search) {
    const sp = new URLSearchParams(search);
    for (const [k, v] of sp.entries()) {
      query[k] = v;
    }
  }
  return { pathname: pathname ?? "", query };
}

async function dispatchVercel(
  req: ConformanceRequest
): Promise<NormalizedResponse> {
  const { pathname, query } = parseUrl(req.url);
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let responseBody: unknown = undefined;

  const res: Partial<VercelResponse> = {
    status(code: number) {
      statusCode = code;
      return this as VercelResponse;
    },
    json(data: unknown) {
      responseBody = data;
      return this as VercelResponse;
    },
    send(data: unknown) {
      responseBody = typeof data === "string" ? JSON.parse(data) : data;
      return this as VercelResponse;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = String(value);
      return this as VercelResponse;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end() {
      return this as VercelResponse;
    },
  };

  const reqHeaders: Record<string, string | string[]> = {
    ...(req.headers ?? {}),
    ...(req.ip ? { "x-vercel-forwarded-for": req.ip } : {}),
  };

  const baseReq = {
    method: req.method,
    headers: reqHeaders,
    body: req.body,
    socket: { remoteAddress: req.ip ?? "127.0.0.1" },
  };

  // Dispatch to corresponding Vercel serverless function based on route
  if (pathname === "/api/v1/vaults") {
    await vaultsHandler(
      { ...baseReq, query } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else if (pathname.startsWith("/api/v1/vaults/")) {
    const vaultId = pathname.replace("/api/v1/vaults/", "");
    await vaultDetailHandler(
      { ...baseReq, query: { ...query, vaultId } } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else if (
    pathname.startsWith("/api/v1/positions/") &&
    pathname.endsWith("/history")
  ) {
    const publicKey = pathname
      .replace("/api/v1/positions/", "")
      .replace("/history", "");
    await positionHistoryHandler(
      {
        ...baseReq,
        query: { ...query, publicKey },
      } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else if (pathname.startsWith("/api/v1/positions/")) {
    const publicKey = pathname.replace("/api/v1/positions/", "");
    await positionsHandler(
      {
        ...baseReq,
        query: { ...query, publicKey },
      } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else if (pathname.startsWith("/api/v1/tx/")) {
    const action = pathname.replace("/api/v1/tx/", "");
    await txHandler(
      { ...baseReq, query: { ...query, action } } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else if (pathname.startsWith("/api/v1/keepers/")) {
    const action = pathname.replace("/api/v1/keepers/", "");
    await keepersHandler(
      { ...baseReq, query: { ...query, action } } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else if (pathname.startsWith("/api/v1/admin/")) {
    const resource = pathname.replace("/api/v1/admin/", "");
    await adminHandler(
      { ...baseReq, query: { ...query, resource } } as unknown as VercelRequest,
      res as VercelResponse
    );
  } else {
    statusCode = 404;
    responseBody = { error: "Unknown route" };
  }

  return { status: statusCode, headers, body: responseBody };
}

describe("Cross-Implementation API Conformance Suite (#1298)", () => {
  let fastifyApp: FastifyInstance;

  beforeAll(async () => {
    fastifyApp = await buildApp({ logger: false, enableRateLimit: true });
    await fastifyApp.ready();
  });

  afterAll(async () => {
    await fastifyApp.close();
  });

  beforeEach(() => {
    resetRateLimitForTesting();
  });

  async function dispatchFastify(
    req: ConformanceRequest
  ): Promise<NormalizedResponse> {
    const injectOptions: {
      method: ConformanceRequest["method"];
      url: string;
      remoteAddress: string;
      headers?: Record<string, string>;
      payload?: Record<string, unknown>;
    } = {
      method: req.method,
      url: req.url,
      remoteAddress: req.ip ?? "127.0.0.1",
    };

    if (req.headers) {
      injectOptions.headers = req.headers;
    }
    if (req.body !== undefined) {
      injectOptions.payload = req.body as Record<string, unknown>;
    }

    const res = await fastifyApp.inject(injectOptions);

    let parsedBody: unknown;
    try {
      parsedBody = res.json();
    } catch {
      parsedBody = res.body;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }

    return {
      status: res.statusCode,
      headers,
      body: parsedBody,
    };
  }

  async function assertConformance(
    req: ConformanceRequest,
    options: {
      checkCacheControl?: boolean;
      checkAllowHeader?: boolean;
      checkSecurityHeaders?: boolean;
      checkRateLimitHeaders?: boolean;
    } = {}
  ): Promise<{ vercel: NormalizedResponse; fastify: NormalizedResponse }> {
    const vercel = await dispatchVercel(req);
    const fastify = await dispatchFastify(req);

    // 1. Assert status parity with explicit surface identification on failure
    if (vercel.status !== fastify.status) {
      throw new Error(
        `[Conformance Failure] Status mismatch on ${req.method} ${req.url}:\n` +
          `  Vercel returned ${vercel.status}\n` +
          `  Fastify returned ${fastify.status}\n` +
          `  Vercel Body: ${JSON.stringify(vercel.body)}\n` +
          `  Fastify Body: ${JSON.stringify(fastify.body)}`
      );
    }

    // 2. Assert Cache-Control parity
    if (options.checkCacheControl !== false) {
      const vCache = vercel.headers["cache-control"];
      const fCache = fastify.headers["cache-control"];
      if (vCache !== fCache) {
        throw new Error(
          `[Conformance Failure] Cache-Control header mismatch on ${req.method} ${req.url}:\n` +
            `  Vercel: "${vCache}"\n` +
            `  Fastify: "${fCache}"`
        );
      }
    }

    // 3. Assert Allow header on 405 Method Not Allowed
    if (options.checkAllowHeader || vercel.status === 405) {
      const vAllow = vercel.headers["allow"];
      const fAllow = fastify.headers["allow"];
      if (vAllow !== fAllow) {
        throw new Error(
          `[Conformance Failure] Allow header mismatch on ${req.method} ${req.url}:\n` +
            `  Vercel: "${vAllow}"\n` +
            `  Fastify: "${fAllow}"`
        );
      }
    }

    // 4. Assert baseline security headers
    if (options.checkSecurityHeaders) {
      for (const header of ["x-content-type-options", "x-frame-options"]) {
        const vVal = vercel.headers[header];
        const fVal = fastify.headers[header];
        if (vVal !== fVal) {
          throw new Error(
            `[Conformance Failure] Security header "${header}" mismatch on ${req.method} ${req.url}:\n` +
              `  Vercel: "${vVal}"\n` +
              `  Fastify: "${fVal}"`
          );
        }
      }
    }

    // 5. Assert rate-limit headers
    if (options.checkRateLimitHeaders) {
      for (const header of ["x-ratelimit-limit", "x-ratelimit-remaining"]) {
        const vVal = vercel.headers[header];
        const fVal = fastify.headers[header];
        if (vVal !== fVal) {
          throw new Error(
            `[Conformance Failure] Rate-limit header "${header}" mismatch on ${req.method} ${req.url}:\n` +
              `  Vercel: "${vVal}"\n` +
              `  Fastify: "${fVal}"`
          );
        }
      }
    }

    // 6. Assert body parity
    const normVercel = normalizeBody(vercel.body);
    const normFastify = normalizeBody(fastify.body);
    expect(
      normVercel,
      `[Conformance Failure] Body mismatch on ${req.method} ${req.url}:\n` +
        `  Vercel: ${JSON.stringify(normVercel)}\n` +
        `  Fastify: ${JSON.stringify(normFastify)}`
    ).toEqual(normFastify);

    return { vercel, fastify };
  }

  describe("Route Coverage: Success & Error Cases", () => {
    describe("1. /api/v1/vaults", () => {
      it("success: returns identical vaults list and cache headers", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "GET", url: "/api/v1/vaults" },
          { checkCacheControl: true, checkSecurityHeaders: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
      });

      it("error: returns 405 Method Not Allowed on POST with Allow: GET", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "POST", url: "/api/v1/vaults" },
          { checkAllowHeader: true }
        );
        expect(vercel.status).toBe(405);
        expect(fastify.status).toBe(405);
        expect(vercel.headers["allow"]).toBe("GET");
      });
    });

    describe("2. /api/v1/vaults/:vaultId", () => {
      it("success: returns identical single vault detail", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "GET", url: "/api/v1/vaults/meridian-usdc" },
          { checkCacheControl: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
      });

      it("error: returns 404 for unrecognized vaultId", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "GET",
          url: "/api/v1/vaults/unknown-vault-id",
        });
        expect(vercel.status).toBe(404);
        expect(fastify.status).toBe(404);
      });
    });

    describe("3. /api/v1/positions/:publicKey", () => {
      it("success: returns identical positions with no-store cache header", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "GET", url: `/api/v1/positions/${FIXTURE_PUBLIC_KEY}` },
          { checkCacheControl: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
        expect(vercel.headers["cache-control"]).toBe("no-store");
      });

      it("error: returns 400 for invalid public key", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "GET",
          url: "/api/v1/positions/invalid-public-key",
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });

    describe("4. /api/v1/positions/:publicKey/history", () => {
      it("success: returns identical position history snapshots", async () => {
        const { vercel, fastify } = await assertConformance(
          {
            method: "GET",
            url: `/api/v1/positions/${FIXTURE_PUBLIC_KEY}/history?days=30`,
          },
          { checkCacheControl: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
        expect(vercel.headers["cache-control"]).toBe("no-store");
      });

      it("error: returns 400 for negative or invalid days parameter", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "GET",
          url: `/api/v1/positions/${FIXTURE_PUBLIC_KEY}/history?days=-5`,
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });

    describe("5. /api/v1/tx/deposit", () => {
      it("success: returns built deposit transaction XDR and fee", async () => {
        const payload = {
          walletAddress: FIXTURE_PUBLIC_KEY,
          vaultId: "meridian-usdc",
          amount: "100.5",
          riskAcknowledged: true,
        };
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/deposit",
          body: payload,
        });
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
      });

      it("error: returns 400 when required payload parameters are missing", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/deposit",
          body: { amount: "100" }, // missing walletAddress and riskAcknowledged
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });

    describe("6. /api/v1/tx/withdraw", () => {
      it("success: returns built withdraw transaction XDR and fee", async () => {
        const payload = {
          walletAddress: FIXTURE_PUBLIC_KEY,
          vaultId: "meridian-usdc",
          shares: "50",
        };
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/withdraw",
          body: payload,
        });
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
      });

      it("error: returns 400 for non-numeric withdraw amount", async () => {
        const payload = {
          walletAddress: FIXTURE_PUBLIC_KEY,
          vaultId: "meridian-usdc",
          shares: "not-a-number",
        };
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/withdraw",
          body: payload,
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });

    describe("7. /api/v1/tx/add-trustline", () => {
      it("success: returns built trustline transaction XDR", async () => {
        const payload = {
          walletAddress: FIXTURE_PUBLIC_KEY,
        };
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/add-trustline",
          body: payload,
        });
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
      });

      it("error: returns 400 when asset parameter is missing", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/add-trustline",
          body: { walletAddress: "invalid-address" },
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });

    describe("8. /api/v1/tx/submit", () => {
      it("success: returns transaction hash on successful submission", async () => {
        const payload = {
          xdr: "AAAA_SIGNED_TRANSACTION_ENVELOPE_XDR",
        };
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/submit",
          body: payload,
        });
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
      });

      it("error: returns 400 when signedXdr is missing", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "POST",
          url: "/api/v1/tx/submit",
          body: {},
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });

    describe("9. /api/v1/keepers/health", () => {
      it("success: returns keeper health report with no-store header", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "GET", url: "/api/v1/keepers/health" },
          { checkCacheControl: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
        expect(vercel.headers["cache-control"]).toBe("no-store");
      });
    });

    describe("10. /api/v1/admin/vault-state", () => {
      it("success: returns coordinator vault state with no-store header", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "GET", url: "/api/v1/admin/vault-state" },
          { checkCacheControl: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
        expect(vercel.headers["cache-control"]).toBe("no-store");
      });

      it("error: returns 405 Method Not Allowed on POST with Allow: GET", async () => {
        const { vercel, fastify } = await assertConformance(
          { method: "POST", url: "/api/v1/admin/vault-state" },
          { checkAllowHeader: true }
        );
        expect(vercel.status).toBe(405);
        expect(fastify.status).toBe(405);
      });
    });

    describe("11. /api/v1/admin/history", () => {
      it("success: returns admin action history with 30s CDN cache header", async () => {
        const { vercel, fastify } = await assertConformance(
          {
            method: "GET",
            url: "/api/v1/admin/history?vaultId=meridian-usdc",
          },
          { checkCacheControl: true }
        );
        expect(vercel.status).toBe(200);
        expect(fastify.status).toBe(200);
        expect(vercel.headers["cache-control"]).toBe(
          "public, s-maxage=30, stale-while-revalidate=120"
        );
      });

      it("error: returns 400 when vaultId query parameter is omitted", async () => {
        const { vercel, fastify } = await assertConformance({
          method: "GET",
          url: "/api/v1/admin/history",
        });
        expect(vercel.status).toBe(400);
        expect(fastify.status).toBe(400);
      });
    });
  });

  describe("Parity: Idempotency", () => {
    it("read idempotency: repeated identical requests yield identical normalized responses", async () => {
      const req: ConformanceRequest = {
        method: "GET",
        url: "/api/v1/vaults",
      };

      const first = await assertConformance(req);
      const second = await assertConformance(req);

      expect(normalizeBody(first.vercel.body)).toEqual(
        normalizeBody(second.vercel.body)
      );
      expect(normalizeBody(first.fastify.body)).toEqual(
        normalizeBody(second.fastify.body)
      );
    });

    it("write idempotency: repeated transaction build yields identical simulation results", async () => {
      const req: ConformanceRequest = {
        method: "POST",
        url: "/api/v1/tx/deposit",
        body: {
          publicKey: FIXTURE_PUBLIC_KEY,
          vaultId: "meridian-usdc",
          amount: "250.00",
        },
      };

      const first = await assertConformance(req);
      const second = await assertConformance(req);

      expect(normalizeBody(first.vercel.body)).toEqual(
        normalizeBody(second.vercel.body)
      );
      expect(normalizeBody(first.fastify.body)).toEqual(
        normalizeBody(second.fastify.body)
      );
    });
  });

  describe("Parity: Rate Limiting & Rate-Limit Headers", () => {
    it("both surfaces emit identical rate limit headers on normal requests", async () => {
      const testIp = "192.168.1.100";
      const { vercel, fastify } = await assertConformance(
        { method: "GET", url: "/api/v1/vaults", ip: testIp },
        { checkRateLimitHeaders: true }
      );

      expect(vercel.headers["x-ratelimit-limit"]).toBe("100");
      expect(fastify.headers["x-ratelimit-limit"]).toBe("100");
    });

    it("both surfaces return 429 with identical error payload and retry-after when limit exceeded", async () => {
      const burstIp = "192.168.1.200";

      // Exhaust 100 requests on both surfaces
      for (let i = 0; i < 100; i++) {
        await dispatchVercel({
          method: "GET",
          url: "/api/v1/vaults",
          ip: burstIp,
        });
        await dispatchFastify({
          method: "GET",
          url: "/api/v1/vaults",
          ip: burstIp,
        });
      }

      // 101st request should be rate-limited on both surfaces
      const { vercel, fastify } = await assertConformance({
        method: "GET",
        url: "/api/v1/vaults",
        ip: burstIp,
      });

      expect(vercel.status).toBe(429);
      expect(fastify.status).toBe(429);
      const rateLimited = {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Try again in a minute.",
          requestId: "[REQUEST_ID]",
        },
      };
      expect(normalizeBody(vercel.body)).toEqual(rateLimited);
      expect(normalizeBody(fastify.body)).toEqual(rateLimited);
      expect(vercel.headers["retry-after"]).toBe("60");
      expect(fastify.headers["retry-after"]).toBe("60");
    });
  });
});
