import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
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

// Stub admin-auth so these tests are isolated to the handler contract and do
// not exercise the challenge/verify flow (which has its own test file).
// handleGetAdminHistory imports verifyAdmin from "./admin-auth" inside the
// api-core package; mocking by the package-relative path intercepts the binding.
vi.mock("../../packages/api-core/dist/admin-auth.js", () => ({
  verifyAdmin: vi.fn(async () => null),
}));

import { handleGetAdminHistory } from "@meridian/api-core";

// A placeholder authorization value — verifyAdmin is stubbed to always pass,
// so the actual token content does not matter here.
const AUTH = "Bearer test-token";

describe("handleGetAdminHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown vault", async () => {
    const result = await handleGetAdminHistory("unknown-vault", AUTH);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "vault not found or missing contractId",
      vaultId: "unknown-vault",
    });
  });

  it("returns 200 with actions for a known vault", async () => {
    const result = await handleGetAdminHistory("meridian-usdc", AUTH);
    expect(result.status).toBe(200);
    const body = result.body as { actions: Array<{ type: string }> };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.type).toBe("set_paused");
  });
});
