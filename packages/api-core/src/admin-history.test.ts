import { describe, it, expect, vi, beforeEach } from "vitest";

// APP_NETWORK is a module-level constant resolved from STELLAR_NETWORK at
// import time, so tests switch networks by mutating this shared object rather
// than re-importing the handler.
const appNetwork = vi.hoisted(() => ({
  network: "mainnet",
  rpcUrl: "",
  passphrase: "",
}));

vi.mock("@meridian/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/shared")>();
  return { ...actual, APP_NETWORK: appNetwork };
});

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    getAdminActionHistory: vi.fn(async () => []),
  };
});

import { STELLAR_NETWORKS } from "@meridian/shared";
import {
  getAdminActionHistory,
  KNOWN_POOLS,
} from "@meridian/stellar-sdk-helpers";
import { handleGetAdminHistory } from "./admin-history";

function useNetwork(name: "mainnet" | "testnet") {
  Object.assign(appNetwork, STELLAR_NETWORKS[name]);
}

const MAINNET_BLEND_KEY = "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf";

beforeEach(() => {
  vi.clearAllMocks();
  useNetwork("mainnet");
});

describe("handleGetAdminHistory vault resolution", () => {
  it("resolves meridian-usdc from the mainnet map on mainnet", async () => {
    const result = await handleGetAdminHistory("meridian-usdc");

    expect(result.status).toBe(200);
    expect(getAdminActionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ network: "mainnet" }),
      KNOWN_POOLS.mainnet["meridian-usdc"]!.contractId,
      expect.anything()
    );
  });

  it("resolves meridian-usdc from the testnet map on testnet", async () => {
    // meridian-usdc exists in both maps; the old mainnet-first lookup made the
    // testnet contract unreachable.
    useNetwork("testnet");

    const result = await handleGetAdminHistory("meridian-usdc");

    const testnetContract = KNOWN_POOLS.testnet["meridian-usdc"]!.contractId;
    expect(testnetContract).not.toBe(
      KNOWN_POOLS.mainnet["meridian-usdc"]!.contractId
    );
    expect(result.status).toBe(200);
    expect((result.body as { contractId: string }).contractId).toBe(
      testnetContract
    );
    expect(getAdminActionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ network: "testnet" }),
      testnetContract,
      expect.anything()
    );
  });

  it("does not fall back to a mainnet-only vault on testnet", async () => {
    useNetwork("testnet");

    const result = await handleGetAdminHistory(MAINNET_BLEND_KEY);

    expect(result.status).toBe(404);
    expect(getAdminActionHistory).not.toHaveBeenCalled();
  });

  it("does not fall back to a testnet-only vault on mainnet", async () => {
    const original = KNOWN_POOLS.testnet["meridian-usdc"]!;
    KNOWN_POOLS.testnet["testnet-only"] = { ...original, id: "testnet-only" };
    try {
      const result = await handleGetAdminHistory("testnet-only");

      expect(result.status).toBe(404);
      expect(getAdminActionHistory).not.toHaveBeenCalled();
    } finally {
      delete KNOWN_POOLS.testnet["testnet-only"];
    }
  });
});

describe("handleGetAdminHistory upstream bounds", () => {
  it("caps pages and sets a time budget on the Horizon scan", async () => {
    await handleGetAdminHistory("meridian-usdc");

    expect(getAdminActionHistory).toHaveBeenCalledTimes(1);
    const [, , options] = vi.mocked(getAdminActionHistory).mock.calls[0]!;
    expect(options).toEqual({ limit: 50, maxPages: 5, scanTimeoutMs: 8_000 });
  });

  it("returns 500 when the bounded scan times out", async () => {
    const timeout = new DOMException("signal timed out", "TimeoutError");
    vi.mocked(getAdminActionHistory).mockRejectedValueOnce(timeout);

    const result = await handleGetAdminHistory("meridian-usdc");

    expect(result.status).toBe(500);
    expect(result.error).toBe(timeout);
  });
});
