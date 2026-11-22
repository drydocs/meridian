import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Mock all dependencies before importing handlers
vi.mock("../../_lib/middleware.js", async () => {
  const actual = await vi.importActual<typeof import("../../_lib/middleware.js")>(
    "../../_lib/middleware.js"
  );
  return {
    ...actual,
    checkRateLimit: vi.fn(
      async (...args: Parameters<typeof actual.checkRateLimit>) =>
        actual.checkRateLimit(...args)
    ),
  };
});

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ContractSimulationError: actual.ContractSimulationError,
    MissingTrustlineError: actual.MissingTrustlineError,
    buildDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
    buildWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
    buildAddTrustlineTx: vi.fn(async () => ({ xdr: "TRUST_XDR" })),
    submitTx: vi.fn(async () => ({ hash: "HASH" })),
    assertRequiredTrustlines: vi.fn().mockResolvedValue(undefined),
    fetchAllVaults: vi.fn(async () => [
      {
        id: "blend-usdc-fixed",
        protocol: "blend",
        asset: "USDC",
        name: "Blend",
        label: "USDC",
        apy: 5,
        tvl: 1000,
        userBalance: 0,
        riskLevel: "safe",
      },
    ]),
    fetchVaultsWithCache: vi.fn(async () => ({
      vaults: [
        {
          id: "blend-usdc-fixed",
          protocol: "blend",
          asset: "USDC",
          name: "Blend",
          label: "USDC",
          apy: 5,
          tvl: 1000,
          userBalance: 0,
          riskLevel: "safe",
        },
      ],
      cached: false,
    })),
    selectBestVault: vi.fn(() => ({ id: "blend-usdc-fixed" })),
    resolvePositions: vi.fn(async () => []),
    getPositionHistory: vi.fn(async () => []),
    fetchCoordinatorState: vi.fn(async () => ({
      protocol: "blend",
      adapterId: "CADAPTER",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    })),
    runBlendAccrualKeeper: vi.fn(async () => ({
      network: "testnet",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
      discoveredAdapters: 1,
      blendAdapters: 1,
      successes: [],
      skipped: [],
      failures: [],
    })),
    runMigrationKeeper: vi.fn(async () => ({
      network: "testnet",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
      discoveredVaults: 1,
      migrations: [],
      skipped: [],
      failures: [],
    })),
    runAlertKeeper: vi.fn(async () => ({
      network: "testnet",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:01.000Z",
      vaultsChecked: 1,
      alertsSent: [],
      failures: [],
    })),
    runPositionSnapshotKeeper: vi.fn(async () => ({
      network: "testnet",
      tracked: 2,
      processed: 2,
      recorded: 2,
      skipped: 0,
      failures: [],
    })),
    HISTORY_DEFAULT_DAYS: 30,
    HISTORY_MAX_DAYS: 90,
  };
});

import txHandler from "../v1/tx/[action]";
import vaultsHandler from "../v1/vaults/index";
import vaultDetailHandler from "../v1/vaults/[vaultId]";
import positionsHandler from "../v1/positions/[publicKey]";
import positionHistoryHandler from "../v1/positions/[publicKey]/history";
import keepersHandler from "../v1/keepers/[action]";
import adminHandler from "../v1/admin/[resource]";

const PUBKEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  end(): FakeRes;
  setHeader(key: string, value: string): void;
}

function makeRes(): FakeRes & VercelResponse {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
    end() {
      return r;
    },
    setHeader(key: string, value: string) {
      r.headers[key] = value;
    },
  };
  return r as unknown as FakeRes & VercelResponse;
}

const fakeReq = (obj: object) =>
  ({ headers: {}, ...obj }) as unknown as VercelRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("MERIDIAN_MIGRATION_KEEPER_SECRET_KEY", "S".repeat(56));
  vi.stubEnv("MERIDIAN_ALERT_WEBHOOK_URL", "https://hooks.example.com/webhook");
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/v1/tx/[action] - Malformed requests", () => {
  describe("malformed JSON", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "POST",
          body: "{ invalid json",
          headers: { "content-type": "application/json" },
        }),
        res
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe("empty body", () => {
    it("returns 400 when body is completely empty for deposit", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "POST",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when body is completely empty for withdraw", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "withdraw" },
          method: "POST",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when body is completely empty for add-trustline", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "add-trustline" },
          method: "POST",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when body is completely empty for submit", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "submit" },
          method: "POST",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  describe("missing content-type", () => {
    it("handles missing content-type header gracefully", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "POST",
          body: {
            walletAddress: PUBKEY,
            vaultId: "blend-usdc-fixed",
            amount: "10",
            riskAcknowledged: true,
          },
          headers: {},
        }),
        res
      );
      // Should either succeed or return a client error, not a 500
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe("wrong content-type", () => {
    it("handles wrong content-type header gracefully", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "POST",
          body: {
            walletAddress: PUBKEY,
            vaultId: "blend-usdc-fixed",
            amount: "10",
            riskAcknowledged: true,
          },
          headers: { "content-type": "text/plain" },
        }),
        res
      );
      // Should either succeed or return a client error, not a 500
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe("unsupported HTTP methods", () => {
    it("returns 405 for GET on deposit", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "GET",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for PUT on deposit", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "PUT",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for DELETE on deposit", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "deposit" },
          method: "DELETE",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for PATCH on withdraw", async () => {
      const res = makeRes();
      await txHandler(
        fakeReq({
          query: { action: "withdraw" },
          method: "PATCH",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });
  });
});

describe("GET /api/v1/vaults - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 405 for POST", async () => {
      const res = makeRes();
      await vaultsHandler(
        fakeReq({
          method: "POST",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for PUT", async () => {
      const res = makeRes();
      await vaultsHandler(
        fakeReq({
          method: "PUT",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for DELETE", async () => {
      const res = makeRes();
      await vaultsHandler(
        fakeReq({
          method: "DELETE",
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for PATCH", async () => {
      const res = makeRes();
      await vaultsHandler(
        fakeReq({
          method: "PATCH",
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });
  });
});

describe("GET /api/v1/vaults/[vaultId] - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 405 for POST", async () => {
      const res = makeRes();
      await vaultDetailHandler(
        fakeReq({
          method: "POST",
          query: { vaultId: "meridian-usdc" },
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for PUT", async () => {
      const res = makeRes();
      await vaultDetailHandler(
        fakeReq({
          method: "PUT",
          query: { vaultId: "meridian-usdc" },
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for DELETE", async () => {
      const res = makeRes();
      await vaultDetailHandler(
        fakeReq({
          method: "DELETE",
          query: { vaultId: "meridian-usdc" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });
  });

  describe("malformed vaultId", () => {
    it("returns 404 for empty vaultId", async () => {
      const res = makeRes();
      await vaultDetailHandler(
        fakeReq({
          method: "GET",
          query: { vaultId: "" },
        }),
        res
      );
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for non-existent vaultId", async () => {
      const res = makeRes();
      await vaultDetailHandler(
        fakeReq({
          method: "GET",
          query: { vaultId: "non-existent-vault" },
        }),
        res
      );
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("GET /api/v1/positions/[publicKey] - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 405 for POST", async () => {
      const res = makeRes();
      await positionsHandler(
        fakeReq({
          method: "POST",
          query: { publicKey: PUBKEY },
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for PUT", async () => {
      const res = makeRes();
      await positionsHandler(
        fakeReq({
          method: "PUT",
          query: { publicKey: PUBKEY },
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for DELETE", async () => {
      const res = makeRes();
      await positionsHandler(
        fakeReq({
          method: "DELETE",
          query: { publicKey: PUBKEY },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });
  });

  describe("malformed publicKey", () => {
    it("returns 400 for too short public key", async () => {
      const res = makeRes();
      await positionsHandler(
        fakeReq({
          method: "GET",
          query: { publicKey: "too-short" },
        }),
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty public key", async () => {
      const res = makeRes();
      await positionsHandler(
        fakeReq({
          method: "GET",
          query: { publicKey: "" },
        }),
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid characters in public key", async () => {
      const res = makeRes();
      await positionsHandler(
        fakeReq({
          method: "GET",
          query: { publicKey: "G" + "!".repeat(55) },
        }),
        res
      );
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("GET /api/v1/positions/[publicKey]/history - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 405 for POST", async () => {
      const res = makeRes();
      await positionHistoryHandler(
        fakeReq({
          method: "POST",
          query: { publicKey: PUBKEY },
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for PUT", async () => {
      const res = makeRes();
      await positionHistoryHandler(
        fakeReq({
          method: "PUT",
          query: { publicKey: PUBKEY },
          body: {},
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });

    it("returns 405 for DELETE", async () => {
      const res = makeRes();
      await positionHistoryHandler(
        fakeReq({
          method: "DELETE",
          query: { publicKey: PUBKEY },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers["Allow"]).toBe("GET");
    });
  });

  describe("malformed publicKey", () => {
    it("returns 400 for invalid public key", async () => {
      const res = makeRes();
      await positionHistoryHandler(
        fakeReq({
          method: "GET",
          query: { publicKey: "invalid-key" },
        }),
        res
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe("malformed days parameter", () => {
    it("returns 400 for non-numeric days value", async () => {
      const res = makeRes();
      await positionHistoryHandler(
        fakeReq({
          method: "GET",
          query: { publicKey: PUBKEY, days: "abc" },
        }),
        res
      );
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for negative days value", async () => {
      const res = makeRes();
      await positionHistoryHandler(
        fakeReq({
          method: "GET",
          query: { publicKey: PUBKEY, days: "-5" },
        }),
        res
      );
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("POST /api/v1/keepers/[action] - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 405 for GET on accrual keeper", async () => {
      const res = makeRes();
      await keepersHandler(
        fakeReq({
          method: "GET",
          query: { action: "accrual" },
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for PUT on migration keeper", async () => {
      const res = makeRes();
      await keepersHandler(
        fakeReq({
          method: "PUT",
          query: { action: "migration" },
          body: {},
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for DELETE on snapshot keeper", async () => {
      const res = makeRes();
      await keepersHandler(
        fakeReq({
          method: "DELETE",
          query: { action: "snapshot" },
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });
  });

  describe("missing authorization", () => {
    it("returns 401 when authorization header is missing", async () => {
      const res = makeRes();
      await keepersHandler(
        fakeReq({
          method: "POST",
          query: { action: "accrual" },
          headers: {},
        }),
        res
      );
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 when authorization token is wrong", async () => {
      const res = makeRes();
      await keepersHandler(
        fakeReq({
          method: "POST",
          query: { action: "accrual" },
          headers: { authorization: "Bearer wrong-token" },
        }),
        res
      );
      expect(res.statusCode).toBe(401);
    });
  });

  describe("unknown action", () => {
    it("returns 404 for unknown keeper action", async () => {
      const res = makeRes();
      await keepersHandler(
        fakeReq({
          method: "POST",
          query: { action: "unknown-action" },
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("POST /api/v1/admin/[resource] - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 405 for GET on admin endpoint", async () => {
      const res = makeRes();
      await adminHandler(
        fakeReq({
          method: "GET",
          query: { resource: "coordinator" },
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for PUT on admin endpoint", async () => {
      const res = makeRes();
      await adminHandler(
        fakeReq({
          method: "PUT",
          query: { resource: "coordinator" },
          body: {},
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });

    it("returns 405 for DELETE on admin endpoint", async () => {
      const res = makeRes();
      await adminHandler(
        fakeReq({
          method: "DELETE",
          query: { resource: "coordinator" },
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(405);
    });
  });

  describe("missing authorization", () => {
    it("returns 401 when authorization header is missing", async () => {
      const res = makeRes();
      await adminHandler(
        fakeReq({
          method: "POST",
          query: { resource: "coordinator" },
          headers: {},
        }),
        res
      );
      expect(res.statusCode).toBe(401);
    });
  });

  describe("unknown resource", () => {
    it("returns 404 for unknown admin resource", async () => {
      const res = makeRes();
      await adminHandler(
        fakeReq({
          method: "POST",
          query: { resource: "unknown-resource" },
          headers: { authorization: "Bearer cron-secret" },
        }),
        res
      );
      expect(res.statusCode).toBe(404);
    });
  });
});
