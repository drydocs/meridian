import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

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

import {
  createAdminChallenge,
  handleGetAdminHistory,
  resetAdminAuthForTesting,
  verifyAdminChallenge,
} from "@meridian/api-core";
import {
  fetchVaultAdmin,
  getAdminActionHistory,
} from "@meridian/stellar-sdk-helpers";

describe("handleGetAdminHistory", () => {
  const admin = Keypair.random();

  beforeEach(() => {
    process.env.MERIDIAN_ADMIN_SESSION_SECRET = "test-only-secret";
    delete process.env.VERCEL_ENV;
    resetAdminAuthForTesting();
    vi.clearAllMocks();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(admin.publicKey());
  });

  async function tokenFor(keypair: Keypair = admin) {
    const challengeResult = await createAdminChallenge(keypair.publicKey());
    const challenge = (challengeResult.body as { challenge: string }).challenge;
    const signature = keypair.sign(Buffer.from(challenge)).toString("base64");
    const result = await verifyAdminChallenge({
      address: keypair.publicKey(),
      challenge,
      signature,
    });
    return (result.body as { token: string }).token;
  }

  it("returns 404 for an unknown vault", async () => {
    const result = await handleGetAdminHistory("unknown-vault");
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "vault not found or missing contractId",
      vaultId: "unknown-vault",
    });
  });

  it("returns 200 with actions for a known vault", async () => {
    const result = await handleGetAdminHistory(
      "meridian-usdc",
      `Bearer ${await tokenFor()}`
    );
    expect(result.status).toBe(200);
    const body = result.body as { actions: Array<{ type: string }> };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.type).toBe("set_paused");
  });

  it("rejects a stale admin session after admin rotation", async () => {
    const token = await tokenFor();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(Keypair.random().publicKey());
    const result = await handleGetAdminHistory("meridian-usdc", `Bearer ${token}`);
    expect(result.status).toBe(403);
    expect(getAdminActionHistory).not.toHaveBeenCalled();
  });

  it("fails closed when the live admin lookup fails", async () => {
    vi.mocked(fetchVaultAdmin).mockRejectedValueOnce(new Error("rpc down"));
    const token = await tokenFor();
    const result = await handleGetAdminHistory("meridian-usdc", `Bearer ${token}`);
    expect(result.status).toBe(503);
    expect(getAdminActionHistory).not.toHaveBeenCalled();
  });
});
