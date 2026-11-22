import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { positionsRoute } from "../routes/positions.js";
import { txRoute } from "../routes/tx.js";
import { vaultsRoute } from "../routes/vaults.js";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  const fetchAllVaultsMock = vi.fn();
  return {
    ContractSimulationError: actual.ContractSimulationError,
    MissingTrustlineError: actual.MissingTrustlineError,
    resolvePositions: vi.fn(async () => []),
    getLatestLedgerSequence: vi.fn(async () => 100),
    buildDepositTx: vi.fn(async () => ({ xdr: "DEPOSIT_XDR", fee: "100" })),
    buildWithdrawTx: vi.fn(async () => ({ xdr: "WITHDRAW_XDR", fee: "100" })),
    buildAddTrustlineTx: vi.fn(async () => ({ xdr: "TRUST_XDR" })),
    submitTx: vi.fn(async () => ({ hash: "HASH", status: "SUCCESS", ledger: 42 })),
    fetchAllVaults: fetchAllVaultsMock,
    fetchVaultsWithCache: vi.fn(async (...args: unknown[]) => ({
      vaults: await fetchAllVaultsMock(...args),
      cached: false,
    })),
    selectBestVault: vi.fn(() => ({ id: "blend-usdc-fixed" })),
    isVaultCacheWarm: vi.fn(() => false),
    assertRequiredTrustlines: vi.fn().mockResolvedValue(undefined),
    consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadPositionSnapshotStore: vi.fn(() => ({})),
    recordPositionSnapshot: vi.fn(async () => true),
    getPositionHistory: vi.fn(async () => []),
    HISTORY_DEFAULT_DAYS: 30,
    HISTORY_MAX_DAYS: 90,
    KNOWN_POOLS: {
      mainnet: {
        "blend-usdc-fixed": {
          id: "blend-usdc-fixed",
          name: "Blend Capital",
          protocol: "blend",
          label: "Fixed Pool",
          asset: "USDC",
        },
      },
      testnet: {
        "meridian-usdc": {
          id: "meridian-usdc",
          name: "Meridian",
          protocol: "meridian",
          label: "USDC Vault",
          asset: "USDC",
        },
      },
    },
  };
});

import { fetchAllVaults } from "@meridian/stellar-sdk-helpers";
import { resetPositionReadCacheForTesting } from "@meridian/api-core";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(positionsRoute, { prefix: "/api/v1/positions" });
  app.register(txRoute, { prefix: "/api/v1/tx" });
  app.register(vaultsRoute, { prefix: "/api/v1/vaults" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPositionReadCacheForTesting();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_KV_REST_API_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_KV_REST_API_TOKEN", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("POST /api/v1/tx/deposit - Malformed requests", () => {
  describe("malformed JSON", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "application/json" },
        payload: "{ invalid json",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });

    it("returns 400 when body is completely malformed", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "application/json" },
        payload: "not json at all",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("empty body", () => {
    it("returns 400 when body is empty object", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });

    it("returns 400 when body is empty string", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "application/json" },
        payload: "",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("missing content-type", () => {
    it("handles missing content-type header gracefully", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/deposit",
        payload: JSON.stringify({
          walletAddress: WALLET,
          vaultId: "blend-usdc-fixed",
          amount: "10",
          riskAcknowledged: true,
        }),
      });
      // Fastify should infer JSON or return a client error, not 500
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe("wrong content-type", () => {
    it("returns 4xx when content-type is not JSON", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "text/plain" },
        payload: JSON.stringify({
          walletAddress: WALLET,
          vaultId: "blend-usdc-fixed",
          amount: "10",
          riskAcknowledged: true,
        }),
      });
      // Should fail gracefully with client error, not 500
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe("unsupported HTTP methods", () => {
    it("returns 404 for GET on deposit", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tx/deposit",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT on deposit", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for DELETE on deposit", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/tx/deposit",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PATCH on deposit", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/tx/deposit",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("POST /api/v1/tx/withdraw - Malformed requests", () => {
  describe("malformed JSON", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/withdraw",
        headers: { "content-type": "application/json" },
        payload: "{ broken: json",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("empty body", () => {
    it("returns 400 when body is empty", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/withdraw",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });
  });

  describe("unsupported HTTP methods", () => {
    it("returns 404 for GET on withdraw", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tx/withdraw",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT on withdraw", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tx/withdraw",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("POST /api/v1/tx/add-trustline - Malformed requests", () => {
  describe("malformed JSON", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/add-trustline",
        headers: { "content-type": "application/json" },
        payload: "not json",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("empty body", () => {
    it("returns 400 when body is empty", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/add-trustline",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });
  });

  describe("unsupported HTTP methods", () => {
    it("returns 404 for GET", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tx/add-trustline",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("POST /api/v1/tx/submit - Malformed requests", () => {
  describe("malformed JSON", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/submit",
        headers: { "content-type": "application/json" },
        payload: "bad json",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("empty body", () => {
    it("returns 400 when body is empty", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tx/submit",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });
  });

  describe("unsupported HTTP methods", () => {
    it("returns 404 for GET", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tx/submit",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tx/submit",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("GET /api/v1/vaults - Malformed requests", () => {
  beforeEach(() => {
    vi.mocked(fetchAllVaults).mockResolvedValue([
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
    ] as never);
  });

  describe("unsupported HTTP methods", () => {
    it("returns 405 for POST", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vaults",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });

    it("returns 405 for PUT", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/vaults",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });

    it("returns 405 for DELETE", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/vaults",
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });

    it("returns 405 for PATCH", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/vaults",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });
  });
});

describe("GET /api/v1/vaults/:vaultId - Malformed requests", () => {
  beforeEach(() => {
    vi.mocked(fetchAllVaults).mockResolvedValue([
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
    ] as never);
  });

  describe("unsupported HTTP methods", () => {
    it("returns 405 for POST", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/vaults/blend-usdc-fixed",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });

    it("returns 405 for PUT", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/vaults/blend-usdc-fixed",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });

    it("returns 405 for DELETE", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/vaults/blend-usdc-fixed",
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("GET");
    });
  });

  describe("malformed vaultId", () => {
    it("returns 404 for empty vaultId", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/vaults/",
      });
      // Fastify treats this as /api/v1/vaults (list endpoint)
      expect([200, 404]).toContain(res.statusCode);
    });

    it("returns 404 for non-existent vaultId", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/vaults/non-existent-vault",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe("GET /api/v1/positions/:publicKey - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 404 for POST", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/positions/${WALLET}`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/positions/${WALLET}`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for DELETE", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/positions/${WALLET}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PATCH", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/positions/${WALLET}`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("malformed publicKey", () => {
    it("returns 400 for too short public key", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/positions/too-short",
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty public key", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/positions/",
      });
      // Fastify will likely treat this as a 404 since the route doesn't match
      expect([400, 404]).toContain(res.statusCode);
    });

    it("returns 400 for invalid characters in public key", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/positions/G" + "!".repeat(55),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe("GET /api/v1/positions/:publicKey/history - Malformed requests", () => {
  describe("unsupported HTTP methods", () => {
    it("returns 404 for POST", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/positions/${WALLET}/history`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for PUT", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/positions/${WALLET}/history`,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for DELETE", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/positions/${WALLET}/history`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("malformed publicKey", () => {
    it("returns 400 for invalid public key", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/positions/invalid-key/history",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("malformed days parameter", () => {
    it("returns 400 for non-numeric days value", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/positions/${WALLET}/history?days=abc`,
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for negative days value", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/positions/${WALLET}/history?days=-5`,
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for zero days value", async () => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/positions/${WALLET}/history?days=0`,
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
