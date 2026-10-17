import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>()),
  fetchVaultAdmin: vi.fn(),
}));

import {
  createAdminChallenge,
  resetAdminAuthForTesting,
  verifyAdmin,
  verifyAdminChallenge,
} from "./admin-auth";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";

const CONTRACT_ID = "CVAULT";

async function proof(keypair: Keypair) {
  const challengeResult = await createAdminChallenge(keypair.publicKey());
  const challenge = (challengeResult.body as { challenge: string }).challenge;
  const signature = keypair.sign(Buffer.from(challenge)).toString("base64");
  const verified = await verifyAdminChallenge({
    address: keypair.publicKey(),
    challenge,
    signature,
  });
  return (verified.body as { token: string }).token;
}

describe("admin challenge and session authentication", () => {
  beforeEach(() => {
    process.env.MERIDIAN_ADMIN_SESSION_SECRET = "test-only-secret";
    delete process.env.VERCEL_ENV;
    resetAdminAuthForTesting();
    vi.clearAllMocks();
  });

  it("rejects a header-only public key without a signed session", async () => {
    const keypair = Keypair.random();
    const result = await verifyAdmin(CONTRACT_ID, `Bearer ${keypair.publicKey()}`);
    expect(result?.status).toBe(401);
    expect(fetchVaultAdmin).not.toHaveBeenCalled();
  });

  it("accepts a valid signature from the current admin", async () => {
    const keypair = Keypair.random();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(keypair.publicKey());
    const token = await proof(keypair);
    expect(await verifyAdmin(CONTRACT_ID, `Bearer ${token}`)).toBeNull();
    expect(fetchVaultAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: CONTRACT_ID })
    );
  });

  it("rejects a validly signed non-admin with 403", async () => {
    const signer = Keypair.random();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(Keypair.random().publicKey());
    const token = await proof(signer);
    expect((await verifyAdmin(CONTRACT_ID, `Bearer ${token}`))?.status).toBe(403);
  });

  it("rejects an expired challenge and a replayed challenge", async () => {
    const keypair = Keypair.random();
    const challengeResult = await createAdminChallenge(keypair.publicKey());
    const challenge = (challengeResult.body as { challenge: string }).challenge;
    const signature = keypair.sign(Buffer.from(challenge)).toString("base64");

    const first = await verifyAdminChallenge({
      address: keypair.publicKey(),
      challenge,
      signature,
    });
    expect(first.status).toBe(200);
    const replay = await verifyAdminChallenge({
      address: keypair.publicKey(),
      challenge,
      signature,
    });
    expect(replay.status).toBe(401);

    vi.useFakeTimers();
    try {
      const expiredResult = await createAdminChallenge(keypair.publicKey());
      const expiredChallenge = (expiredResult.body as { challenge: string }).challenge;
      const expiredSignature = keypair
        .sign(Buffer.from(expiredChallenge))
        .toString("base64");
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      expect(
        (
          await verifyAdminChallenge({
            address: keypair.publicKey(),
            challenge: expiredChallenge,
            signature: expiredSignature,
          })
        ).status
      ).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed signatures and expired tokens without throwing", async () => {
    const keypair = Keypair.random();
    const challengeResult = await createAdminChallenge(keypair.publicKey());
    const challenge = (challengeResult.body as { challenge: string }).challenge;
    const malformed = await verifyAdminChallenge({
      address: keypair.publicKey(),
      challenge,
      signature: "not-a-signature",
    });
    expect(malformed.status).toBe(401);
    expect((await verifyAdmin(CONTRACT_ID, "Bearer malformed.token"))?.status).toBe(401);
  });

  it("revokes a previously valid session after admin rotation", async () => {
    const oldAdmin = Keypair.random();
    const newAdmin = Keypair.random();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(oldAdmin.publicKey());
    const token = await proof(oldAdmin);
    expect(await verifyAdmin(CONTRACT_ID, `Bearer ${token}`)).toBeNull();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(newAdmin.publicKey());
    expect((await verifyAdmin(CONTRACT_ID, `Bearer ${token}`))?.status).toBe(403);
  });

  it("denies when the live admin lookup times out", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchVaultAdmin).mockImplementation(
        () => new Promise<string>(() => {})
      );
      const keypair = Keypair.random();
      const token = await proof(keypair);
      const resultPromise = verifyAdmin(CONTRACT_ID, `Bearer ${token}`);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await resultPromise)?.status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });
});
