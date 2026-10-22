import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", () => ({
  fetchVaultsWithCache: vi.fn(async () => ({
    vaults: [{ id: "blend-usdc-fixed", protocol: "blend" }],
    cached: false,
  })),
  fetchAllVaults: vi.fn(async () => [
    { id: "blend-usdc-fixed", protocol: "blend" },
  ]),
  selectBestVault: vi.fn(() => ({ id: "blend-usdc-fixed" })),
  isVaultCacheWarm: vi.fn(() => false),
}));

import { handleGetVaults, handleGetVaultById } from "./vaults";
import {
  fetchVaultsWithCache,
  fetchAllVaults,
  selectBestVault,
} from "@meridian/stellar-sdk-helpers";

beforeEach(() => vi.clearAllMocks());

describe("handleGetVaults", () => {
  it("returns the vault list with recommendedVaultId and cached flag", async () => {
    const result = await handleGetVaults();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      vaults: [{ id: "blend-usdc-fixed" }],
      recommendedVaultId: "blend-usdc-fixed",
      cached: false,
    });
  });

  it("returns cached: true when fetchVaultsWithCache reports a cache hit", async () => {
    vi.mocked(fetchVaultsWithCache).mockResolvedValueOnce({
      vaults: [
        {
          id: "blend-usdc-fixed",
          protocol: "blend",
          asset: "USDC",
          name: "Blend USDC",
          label: "Blend",
          apy: 5,
          tvl: 1000,
          userBalance: 0,
          riskLevel: "safe",
        },
      ],
      cached: true,
    });
    const result = await handleGetVaults();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      cached: true,
    });
  });

  it("returns 500 when the vault fetch fails", async () => {
    const err = new Error("fetch failed");
    vi.mocked(fetchVaultsWithCache).mockRejectedValueOnce(err);
    const result = await handleGetVaults();
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Failed to fetch vaults" });
    expect(result.error).toBe(err);
  });

  it("sets recommendedVaultId to null when no best vault is found", async () => {
    vi.mocked(selectBestVault).mockReturnValueOnce(null);
    const result = await handleGetVaults();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ recommendedVaultId: null });
  });
});

describe("handleGetVaultById", () => {
  it("returns the matching vault", async () => {
    const result = await handleGetVaultById("blend-usdc-fixed");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: "blend-usdc-fixed" });
  });

  it("returns 404 when the vault is not found in the fetched list", async () => {
    vi.mocked(fetchAllVaults).mockResolvedValueOnce([]);
    const result = await handleGetVaultById("unknown");
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "vault not found",
      vaultId: "unknown",
    });
  });

  it("returns 500 when the vault fetch fails", async () => {
    const err = new Error("fetch failed");
    vi.mocked(fetchAllVaults).mockRejectedValueOnce(err);
    const result = await handleGetVaultById("blend-usdc-fixed");
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Failed to fetch vault" });
    expect(result.error).toBe(err);
  });
});
