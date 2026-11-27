import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { positionsRoute } from "../routes/positions.js";
import { txRoute } from "../routes/tx.js";
import { vaultsRoute } from "../routes/vaults.js";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  // Keep the real error classes: api-core narrows on `instanceof`, so a
  // stubbed class would stop behaving like the error it maps to an HTTP status.
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  const fetchAllVaultsMock = vi.fn();
  return {
    ContractSimulationError: actual.ContractSimulationError,
    MissingTrustlineError: actual.MissingTrustlineError,
    resolvePositions: vi.fn(),
    getLatestLedgerSequence: vi.fn(async () => 100),
    buildDepositTx: vi.fn(),
    buildWithdrawTx: vi.fn(),
    buildAddTrustlineTx: vi.fn(),
    // Prices the slippage floor when a build request omits its minimum.
    quoteVaultAction: vi.fn(async ({ action }: { action: string }) => ({
      action,
      fee: "0",
      ledger: 100,
      recommendedMinimum: action === "deposit" ? "9.9" : "4.9",
      slippageBps: 50,
    })),
    submitTx: vi.fn(),
    fetchAllVaults: fetchAllVaultsMock,
    fetchVaultsWithCache: vi.fn(async (...args: unknown[]) => ({
      vaults: await fetchAllVaultsMock(...args),
      cached: false,
    })),
    selectBestVault: vi.fn(),
    isVaultCacheWarm: vi.fn(() => false),
    KNOWN_POOLS: {
      mainnet: {
        "blend-usdc-fixed": {
          id: "blend-usdc-fixed",
          name: "Blend Capital",
          protocol: "blend",
          label: "Fixed Pool",
          asset: "USDC",
        },
        "meridian-usdc": {
          id: "meridian-usdc",
          name: "Meridian",
          protocol: "meridian",
          label: "USDC Vault",
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
    // api-core now calls this on the deposit/withdraw build path. Without a
    // stub it resolved to `undefined` and threw, turning five route cases into
    // 500s instead of their expected statuses.
    assertRequiredTrustlines: vi.fn().mockResolvedValue(undefined),
    // Same trap: the positions handler imports these three, and a missing
    // export throws instead of resolving to undefined, turning its 200 into a 503.
    consoleLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loadPositionSnapshotStore: vi.fn(() => ({})),
    recordPositionSnapshot: vi.fn(async () => true),
    getPositionHistory: vi.fn(async () => []),
    // The history handler reads these two at call time, so the mock has to
    // carry them or every request through that route throws.
    HISTORY_DEFAULT_DAYS: 30,
    HISTORY_MAX_DAYS: 90,
  };
});

import {
  getLatestLedgerSequence,
  resolvePositions,
  buildDepositTx,
  buildWithdrawTx,
  buildAddTrustlineTx,
  quoteVaultAction,
  submitTx,
  fetchAllVaults,
  selectBestVault,
  getPositionHistory,
} from "@meridian/stellar-sdk-helpers";
import { resetPositionReadCacheForTesting } from "@meridian/api-core";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
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
  vi.mocked(getLatestLedgerSequence).mockResolvedValue(100);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });
});

describe("GET /api/v1/positions/:publicKey", () => {
  it("returns 200 with positions from the SDK", async () => {
    const app = buildApp();
    const pos = [
      {
        vaultId: "blend-usdc-fixed",
        shares: 10,
        deposited: 10,
        earned: 0,
        entryTime: 0,
      },
    ];
    vi.mocked(resolvePositions).mockResolvedValue(pos);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ positions: pos });
    expect(res.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("returns 304 for a matching If-None-Match header", async () => {
    const app = buildApp();
    vi.mocked(resolvePositions).mockResolvedValue([]);
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
      headers: { "if-none-match": first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(resolvePositions).toHaveBeenCalledOnce();
  });

  it("omits ETag and does not cache partial position reads", async () => {
    const app = buildApp();
    vi.mocked(resolvePositions)
      .mockImplementationOnce(async (_publicKey, _network, options) => {
        options?.onVaultError?.(new Error("vault RPC down"));
        return [];
      })
      .mockResolvedValueOnce([]);

    const partial = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.headers.etag).toBeUndefined();

    const complete = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
    });
    expect(resolvePositions).toHaveBeenCalledTimes(2);
    expect(complete.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it("accepts refresh=true to bypass the cached positions", async () => {
    const app = buildApp();
    vi.mocked(resolvePositions).mockResolvedValue([]);
    await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
    });
    await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}?refresh=true`,
    });
    expect(resolvePositions).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for an invalid public key", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/not-a-key",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 503 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(resolvePositions).mockRejectedValue(new Error("RPC down"));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("GET /api/v1/positions/:publicKey/history", () => {
  const snapshot = { timestamp: 1, totalValue: 10, totalEarned: 1, vaults: [] };

  it("returns 200 with the snapshots and the default window", async () => {
    const app = buildApp();
    vi.mocked(getPositionHistory).mockResolvedValue([snapshot] as never);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}/history`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: 30, snapshots: [snapshot] });
  });

  it("forwards the days query parameter", async () => {
    const app = buildApp();
    vi.mocked(getPositionHistory).mockResolvedValue([] as never);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}/history?days=7`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: 7 });
    expect(vi.mocked(getPositionHistory).mock.calls[0]?.[3]).toBe(7);
  });

  it("returns 400 for a non-integer days value", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}/history?days=abc`,
    });
    expect(res.statusCode).toBe(400);
    expect(getPositionHistory).not.toHaveBeenCalled();
  });

  it("returns 503 when the history read throws", async () => {
    const app = buildApp();
    vi.mocked(getPositionHistory).mockRejectedValue(new Error("redis down"));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/positions/${WALLET}/history`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("POST /api/v1/tx/deposit", () => {
  const validBody = {
    walletAddress: WALLET,
    vaultId: "blend-usdc-fixed",
    amount: "10",
    riskAcknowledged: true,
  };

  it("returns 200 with xdr and fee from the SDK", async () => {
    const app = buildApp();
    vi.mocked(buildDepositTx).mockResolvedValue({ xdr: "TXXDR", fee: "100" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "TXXDR", fee: "100" });
  });

  it("forwards min_shares_out when provided", async () => {
    const app = buildApp();
    vi.mocked(buildDepositTx).mockResolvedValue({ xdr: "TXXDR", fee: "100" });

    await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, min_shares_out: "9.5" }),
    });
    expect(buildDepositTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      WALLET,
      "10",
      expect.anything(),
      "9.5"
    );
  });

  it("returns 400 when walletAddress is missing", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultId: "blend-usdc-fixed", amount: "10" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 400 when amount does not match the decimal pattern", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, amount: "not-a-number" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when the SDK throws a simulation error", async () => {
    const app = buildApp();
    vi.mocked(buildDepositTx).mockRejectedValue(
      new Error("Simulation failed: HostError")
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("POST /api/v1/tx/withdraw", () => {
  const validBody = {
    walletAddress: WALLET,
    vaultId: "blend-usdc-fixed",
    shares: "5",
  };

  it("returns 200 with xdr and fee from the SDK", async () => {
    const app = buildApp();
    vi.mocked(buildWithdrawTx).mockResolvedValue({
      xdr: "WITHDRAWXDR",
      fee: "100",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "WITHDRAWXDR", fee: "100" });
  });

  it("forwards min_usdc_out when provided", async () => {
    const app = buildApp();
    vi.mocked(buildWithdrawTx).mockResolvedValue({
      xdr: "WITHDRAWXDR",
      fee: "100",
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, min_usdc_out: "4.9" }),
    });
    expect(buildWithdrawTx).toHaveBeenCalledWith(
      "blend-usdc-fixed",
      WALLET,
      "5",
      expect.anything(),
      "4.9"
    );
  });

  it("returns 400 for a missing shares field", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: WALLET,
        vaultId: "blend-usdc-fixed",
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(buildWithdrawTx).mockRejectedValue(new Error("withdraw failed"));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/v1/tx/add-trustline", () => {
  it("returns 200 with xdr from the SDK", async () => {
    const app = buildApp();
    vi.mocked(buildAddTrustlineTx).mockResolvedValue({ xdr: "TRUSTLINEXDR" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/add-trustline",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: WALLET }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "TRUSTLINEXDR" });
  });

  it("returns 400 for an invalid walletAddress", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/add-trustline",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: "bad-address" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(buildAddTrustlineTx).mockRejectedValue(
      new Error("trustline build failed")
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/add-trustline",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: WALLET }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("POST /api/v1/tx/submit", () => {
  it("returns 200 with the submit result from the SDK", async () => {
    const app = buildApp();
    vi.mocked(submitTx).mockResolvedValue({
      hash: "abc123",
      status: "SUCCESS",
      ledger: 42,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: "SIGNEDXDR" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hash: "abc123",
      status: "SUCCESS",
      ledger: 42,
    });
  });

  it("returns 400 for an empty xdr string", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: "" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(submitTx).mockRejectedValue(new Error("submit failed"));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/submit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: "SIGNEDXDR" }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("POST /api/v1/tx/quote", () => {
  const body = {
    action: "deposit",
    walletAddress: WALLET,
    vaultId: "blend-usdc-fixed",
    amount: "10",
  };

  it("returns 200 with the quote from the SDK", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/quote",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      action: "deposit",
      recommendedMinimum: "9.9",
    });
  });

  it("returns 400 when a deposit quote has no amount", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/quote",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, amount: undefined }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns 500 and hides the cause when the quote simulation fails", async () => {
    const app = buildApp();
    vi.mocked(quoteVaultAction).mockRejectedValueOnce(new Error("rpc down"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tx/quote",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Failed to simulate transaction quote",
    });
  });

  it("rejects GET with 405", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/tx/quote" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });
});

describe("GET /api/v1/vaults", () => {
  it("returns 200 with vault list and recommendedVaultId", async () => {
    const app = buildApp();
    const vault = { id: "blend-usdc-fixed", apy: 0.05 };
    vi.mocked(fetchAllVaults).mockResolvedValue([vault] as never);
    vi.mocked(selectBestVault).mockReturnValue(vault as never);

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("vaults");
    expect(body).toHaveProperty("recommendedVaultId", "blend-usdc-fixed");
    expect(body).toHaveProperty("updatedAt");
  });

  it("sets recommendedVaultId to null when no best vault is found", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockResolvedValue([] as never);
    vi.mocked(selectBestVault).mockReturnValue(undefined as never);

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recommendedVaultId: null });
  });

  it("returns 500 when vault fetch fails", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockRejectedValue(new Error("fetch failed"));

    const res = await app.inject({ method: "GET", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(500);
  });

  it("rejects non-GET methods with 405", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/vaults" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    expect(fetchAllVaults).not.toHaveBeenCalled();
  });
});

describe("rate limiting on /api/v1/tx", () => {
  it("shares one 100 request budget across tx routes", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
    app.register(txRoute, { prefix: "/api/v1/tx" });
    await app.ready();

    vi.mocked(buildDepositTx).mockResolvedValue({ xdr: "TXXDR", fee: "100" });
    vi.mocked(buildWithdrawTx).mockResolvedValue({
      xdr: "WITHDRAWXDR",
      fee: "100",
    });

    const deposit = {
      method: "POST" as const,
      url: "/api/v1/tx/deposit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: WALLET,
        vaultId: "blend-usdc-fixed",
        amount: "10",
        riskAcknowledged: true,
      }),
    };
    const withdraw = {
      method: "POST" as const,
      url: "/api/v1/tx/withdraw",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: WALLET,
        vaultId: "blend-usdc-fixed",
        shares: "5",
      }),
    };

    for (let i = 0; i < 50; i++) {
      expect((await app.inject(deposit)).statusCode).toBe(200);
      expect((await app.inject(withdraw)).statusCode).toBe(200);
    }

    expect((await app.inject(deposit)).statusCode).toBe(429);
  });
});

describe("GET /api/v1/vaults/:vaultId", () => {
  it("returns 200 with the matching vault", async () => {
    const app = buildApp();
    const vault = { id: "blend-usdc-fixed", apy: 0.05 };
    vi.mocked(fetchAllVaults).mockResolvedValue([vault] as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vaults/blend-usdc-fixed",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "blend-usdc-fixed" });
  });

  it("returns 404 for an unknown vault ID without fetching", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockResolvedValue([] as never);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vaults/unknown",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
    expect(fetchAllVaults).not.toHaveBeenCalled();
  });

  it("returns 500 when the SDK throws", async () => {
    const app = buildApp();
    vi.mocked(fetchAllVaults).mockRejectedValue(new Error("fetch failed"));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vaults/blend-usdc-fixed",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toHaveProperty("error");
  });

  it("rejects non-GET methods with 405", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vaults/blend-usdc-fixed",
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    expect(fetchAllVaults).not.toHaveBeenCalled();
  });
});

describe("method guards on positions routes", () => {
  it.each([
    `/api/v1/positions/${WALLET}`,
    `/api/v1/positions/${WALLET}/history`,
  ])("rejects non-GET methods on %s with 405", async (url) => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    expect(resolvePositions).not.toHaveBeenCalled();
    expect(getPositionHistory).not.toHaveBeenCalled();
  });
});

describe("method guards on tx routes", () => {
  it.each(["deposit", "withdraw", "add-trustline", "submit"])(
    "rejects GET on /api/v1/tx/%s with 405",
    async (route) => {
      const app = buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tx/${route}`,
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("POST");
      expect(submitTx).not.toHaveBeenCalled();
    }
  );
});
