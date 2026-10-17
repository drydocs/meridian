import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
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
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_API_TOKEN;
    resetAdminAuthForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a header-only public key without a signed session", async () => {
    const keypair = Keypair.random();
    const result = await verifyAdmin(
      CONTRACT_ID,
      `Bearer ${keypair.publicKey()}`
    );
    expect(result?.status).toBe(401);
    expect(fetchVaultAdmin).not.toHaveBeenCalled();
  });

  it("rejects invalid challenge addresses and malformed challenge input", async () => {
    expect((await createAdminChallenge("not-a-stellar-address")).status).toBe(
      400
    );
    const keypair = Keypair.random();
    expect(
      (
        await verifyAdminChallenge({
          address: keypair.publicKey(),
          challenge: "meridian-admin-v1",
          signature: "signature",
        })
      ).status
    ).toBe(401);
    expect(
      (
        await verifyAdminChallenge({
          address: keypair.publicKey(),
          challenge: "",
          signature: "signature",
        })
      ).status
    ).toBe(401);
  });

  it("fails closed when the session secret is missing", async () => {
    const keypair = Keypair.random();
    delete process.env.MERIDIAN_ADMIN_SESSION_SECRET;
    expect((await createAdminChallenge(keypair.publicKey())).status).toBe(200);
    const challengeResult = await createAdminChallenge(keypair.publicKey());
    const challenge = (challengeResult.body as { challenge: string }).challenge;
    const signature = keypair.sign(Buffer.from(challenge)).toString("base64");
    expect(
      (
        await verifyAdminChallenge({
          address: keypair.publicKey(),
          challenge,
          signature,
        })
      ).status
    ).toBe(503);
    expect((await verifyAdmin(CONTRACT_ID, undefined))?.status).toBe(401);
  });

  it("fails closed in a serverless runtime without Redis", async () => {
    const keypair = Keypair.random();
    process.env.VERCEL_ENV = "production";
    expect((await createAdminChallenge(keypair.publicKey())).status).toBe(503);
  });

  it("uses Redis GETDEL for single-use challenges", async () => {
    const keypair = Keypair.random();
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN = "redis-token";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: "OK" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const challengeResult = await createAdminChallenge(keypair.publicKey());
    const challenge = (challengeResult.body as { challenge: string }).challenge;
    const signature = keypair.sign(Buffer.from(challenge)).toString("base64");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: JSON.stringify({
          address: keypair.publicKey(),
          challenge,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        }),
      }),
    });
    const result = await verifyAdminChallenge({
      address: keypair.publicKey(),
      challenge,
      signature,
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body as string)).toEqual(
      ["GETDEL", expect.stringContaining("meridian:admin:challenge:")]
    );
  });

  it("returns unavailable when Redis rejects a challenge write", async () => {
    const keypair = Keypair.random();
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    );
    expect((await createAdminChallenge(keypair.publicKey())).status).toBe(503);
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
    expect((await verifyAdmin(CONTRACT_ID, `Bearer ${token}`))?.status).toBe(
      403
    );
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
      const expiredChallenge = (expiredResult.body as { challenge: string })
        .challenge;
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
    expect(
      (await verifyAdmin(CONTRACT_ID, "Bearer malformed.token"))?.status
    ).toBe(401);

    const invalidSignature = keypair
      .sign(Buffer.from(challenge))
      .toString("base64");
    expect(
      (
        await verifyAdminChallenge({
          address: keypair.publicKey(),
          challenge,
          signature: invalidSignature,
        })
      ).status
    ).toBe(401);

    const secondChallengeResult = await createAdminChallenge(
      keypair.publicKey()
    );
    const secondChallenge = (
      secondChallengeResult.body as { challenge: string }
    ).challenge;
    expect(
      (
        await verifyAdminChallenge({
          address: keypair.publicKey(),
          challenge: secondChallenge,
          signature: Buffer.alloc(64, 1).toString("base64"),
        })
      ).status
    ).toBe(401);

    const malformedPayload = Buffer.from("{", "utf8").toString("base64url");
    const malformedToken = `${malformedPayload}.${createHmac(
      "sha256",
      "test-only-secret"
    )
      .update(malformedPayload)
      .digest("base64url")}`;
    expect((await verifyAdmin(CONTRACT_ID, malformedToken))?.status).toBe(401);

    const emptyPayload = Buffer.from("{}", "utf8").toString("base64url");
    const emptyToken = `${emptyPayload}.${createHmac(
      "sha256",
      "test-only-secret"
    )
      .update(emptyPayload)
      .digest("base64url")}`;
    expect((await verifyAdmin(CONTRACT_ID, emptyToken))?.status).toBe(401);

    const invalidAddressPayload = Buffer.from(
      JSON.stringify({
        sub: "not-a-stellar-address",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
      "utf8"
    ).toString("base64url");
    const invalidAddressToken = `${invalidAddressPayload}.${createHmac(
      "sha256",
      "test-only-secret"
    )
      .update(invalidAddressPayload)
      .digest("base64url")}`;
    expect((await verifyAdmin(CONTRACT_ID, invalidAddressToken))?.status).toBe(
      401
    );
  });

  it("revokes a previously valid session after admin rotation", async () => {
    const oldAdmin = Keypair.random();
    const newAdmin = Keypair.random();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(oldAdmin.publicKey());
    const token = await proof(oldAdmin);
    expect(await verifyAdmin(CONTRACT_ID, `Bearer ${token}`)).toBeNull();
    vi.mocked(fetchVaultAdmin).mockResolvedValue(newAdmin.publicKey());
    expect((await verifyAdmin(CONTRACT_ID, `Bearer ${token}`))?.status).toBe(
      403
    );
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

  it("denies when the live admin lookup fails", async () => {
    const keypair = Keypair.random();
    const token = await proof(keypair);
    vi.mocked(fetchVaultAdmin).mockRejectedValue(new Error("RPC unavailable"));
    expect((await verifyAdmin(CONTRACT_ID, `Bearer ${token}`))?.status).toBe(
      503
    );
  });
});
