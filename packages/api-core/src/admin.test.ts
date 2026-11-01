import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    fetchCoordinatorState: vi.fn(async () => ({
      protocol: "blend",
      adapterId: "ADAPTER_ID",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    })),
    getKeeperHeartbeat: vi.fn(async () => null),
    loadKeeperHeartbeatStore: vi.fn(() => ({})),
  };
});

// Stub admin-auth so these tests are isolated to the handler contract and do
// not exercise the challenge/verify flow (which has its own test file).
vi.mock("./admin-auth", () => ({
  verifyAdmin: vi.fn(async () => null),
}));

import { handleGetKeeperHealth, handleGetVaultState } from "./admin";
import {
  fetchCoordinatorState,
  getKeeperHeartbeat,
  KNOWN_POOLS,
} from "@meridian/stellar-sdk-helpers";
import { verifyAdmin } from "./admin-auth";

beforeEach(() => vi.clearAllMocks());

describe("handleGetKeeperHealth", () => {
  it("reports both keepers as unhealthy when no heartbeat has ever been recorded", async () => {
    vi.mocked(getKeeperHeartbeat).mockResolvedValue(null);
    const result = await handleGetKeeperHealth();
    expect(result.status).toBe(200);
    const body = result.body as { keepers: Array<Record<string, unknown>> };
    expect(body.keepers).toHaveLength(2);
    for (const keeper of body.keepers) {
      expect(keeper.lastSuccessMs).toBeNull();
      expect(keeper.healthy).toBe(false);
    }
  });

  it("reports a keeper healthy when its last success is within schedule", async () => {
    vi.mocked(getKeeperHeartbeat).mockImplementation(async (_store, id) =>
      id === "accrual" ? Date.now() - 60_000 : null
    );
    const result = await handleGetKeeperHealth();
    const body = result.body as { keepers: Array<Record<string, unknown>> };
    const accrual = body.keepers.find((k) => k.id === "accrual");
    expect(accrual?.healthy).toBe(true);
  });

  it("reports a keeper unhealthy when its last success is far overdue", async () => {
    vi.mocked(getKeeperHeartbeat).mockImplementation(async (_store, id) =>
      id === "migration" ? Date.now() - 24 * 60 * 60_000 : null
    );
    const result = await handleGetKeeperHealth();
    const body = result.body as { keepers: Array<Record<string, unknown>> };
    const migration = body.keepers.find((k) => k.id === "migration");
    expect(migration?.healthy).toBe(false);
  });

  it("returns 500 when reading heartbeats throws unexpectedly", async () => {
    const err = new Error("boom");
    vi.mocked(getKeeperHeartbeat).mockRejectedValue(err);
    const result = await handleGetKeeperHealth();
    // getKeeperHeartbeat itself never throws in real usage (see
    // keeper-heartbeat.ts), but the handler still needs to degrade
    // gracefully if a future change to it, or to Promise.all's shape here,
    // ever lets a rejection through.
    expect(result.status).toBe(500);
    expect(result.error).toBe(err);
  });
});

describe("handleGetVaultState", () => {
  it("returns the coordinator vault state for an authorized caller", async () => {
    const result = await handleGetVaultState("Bearer valid-token");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      protocol: "blend",
      adapterId: "ADAPTER_ID",
      totalShares: 1000,
      totalAssets: 1050,
      paused: false,
    });
    expect(verifyAdmin).toHaveBeenCalledWith(
      expect.any(String),
      "Bearer valid-token"
    );
  });

  it("returns the auth error when verifyAdmin rejects the caller", async () => {
    vi.mocked(verifyAdmin).mockResolvedValueOnce({
      status: 401,
      body: { error: "Admin authentication required" },
    });
    const result = await handleGetVaultState(undefined);
    expect(result.status).toBe(401);
    expect(fetchCoordinatorState).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is no longer the current admin", async () => {
    vi.mocked(verifyAdmin).mockResolvedValueOnce({
      status: 403,
      body: { error: "Admin access required" },
    });
    const result = await handleGetVaultState("Bearer stale-token");
    expect(result.status).toBe(403);
    expect(fetchCoordinatorState).not.toHaveBeenCalled();
  });

  it("returns 503 when the on-chain read fails", async () => {
    const err = new Error("rpc unavailable");
    vi.mocked(fetchCoordinatorState).mockRejectedValueOnce(err);
    const result = await handleGetVaultState("Bearer valid-token");
    expect(result.status).toBe(503);
    expect(result.error).toBe(err);
  });

  it("returns 404 when no Meridian coordinator vault is configured for this network", async () => {
    // No mocking hook exists for "no configured vault" today, so simulate it
    // directly: temporarily remove all Meridian entries from the mainnet pool
    // map so the handler's find() returns undefined and triggers the 404 path.
    // Removing the key (not just mutating a property) bypasses the Vitest ESM
    // module isolation issue where property mutations on spread objects are not
    // visible across module boundaries.
    //
    // Targets mainnet: APP_NETWORK defaults to mainnet (the live deployment)
    // unless STELLAR_NETWORK=testnet is set at import time, which it isn't.
    const pools = KNOWN_POOLS.mainnet;
    const removed: Record<string, (typeof pools)[string]> = {};
    for (const [key, val] of Object.entries(pools)) {
      if (val.protocol === "meridian") {
        removed[key] = val;
        delete pools[key];
      }
    }
    if (Object.keys(removed).length === 0) {
      throw new Error("expected at least one mainnet meridian pool to exist");
    }

    try {
      const result = await handleGetVaultState("Bearer valid-token");
      expect(result.status).toBe(404);
      expect(result.body).toEqual({
        error: "No Meridian coordinator vault configured for this network",
      });
      // verifyAdmin is never reached when vault lookup fails.
      expect(verifyAdmin).not.toHaveBeenCalled();
    } finally {
      for (const [key, val] of Object.entries(removed)) {
        pools[key] = val;
      }
    }
  });
});
