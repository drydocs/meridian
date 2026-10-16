import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    fetchVaultAdmin: vi.fn(async () => "GADMIN"),
    getAdminActionHistory: vi.fn(async () => [
      {
        id: "1",
        type: "set_paused",
        timestamp: "2026-08-27T20:00:00Z",
        transactionHash: "HASH1",
        sourceAccount: "GADMIN",
        summary: "Vault deposits paused",
        details: {},
      },
    ]),
  };
});

import { handleGetAdminHistory } from "@meridian/api-core";
import {
  fetchVaultAdmin,
  getAdminActionHistory,
} from "@meridian/stellar-sdk-helpers";

describe("handleGetAdminHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown vault", async () => {
    const result = await handleGetAdminHistory("unknown-vault");
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "vault not found or missing contractId",
      vaultId: "unknown-vault",
    });
  });

  it("returns 200 with actions for a known vault", async () => {
    const result = await handleGetAdminHistory("meridian-usdc", "GADMIN");
    expect(result.status).toBe(200);
    const body = result.body as { actions: Array<{ type: string }> };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.type).toBe("set_paused");
  });

  it("rejects a stale admin session after admin rotation", async () => {
    const result = await handleGetAdminHistory("meridian-usdc", "GSTALE");
    expect(result.status).toBe(403);
    expect(getAdminActionHistory).not.toHaveBeenCalled();
  });

  it("fails closed when the live admin lookup fails", async () => {
    vi.mocked(fetchVaultAdmin).mockRejectedValueOnce(new Error("rpc down"));
    const result = await handleGetAdminHistory("meridian-usdc", "GADMIN");
    expect(result.status).toBe(503);
    expect(getAdminActionHistory).not.toHaveBeenCalled();
  });
});
