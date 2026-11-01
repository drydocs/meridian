import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Module-level hoisting — must appear before any `import` of the module under
// test so vitest can intercept the module factory.
// ---------------------------------------------------------------------------

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return {
    ...actual,
    fetchVaultAdmin: vi.fn(async () => ADMIN_ADDRESS),
  };
});

vi.mock("@meridian/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meridian/shared")>();
  return {
    ...actual,
    APP_NETWORK: { network: "testnet", rpcUrl: "", passphrase: "" },
  };
});

import {
  createAdminChallenge,
  resetAdminAuthForTesting,
  verifyAdmin,
  verifyAdminChallenge,
} from "./admin-auth";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// A deterministic Stellar keypair for all tests — never reaches the network.
const ADMIN_KEYPAIR = Keypair.random();
const ADMIN_ADDRESS = ADMIN_KEYPAIR.publicKey();

// Sign `message` with the admin keypair and return base64.
function signChallenge(message: string): string {
  return Buffer.from(ADMIN_KEYPAIR.sign(Buffer.from(message, "utf8"))).toString(
    "base64"
  );
}

// Build a valid session token by running through the full challenge/verify
// cycle. Returns the `Bearer <token>` authorization header value.
async function buildValidToken(
  address: string = ADMIN_ADDRESS,
  keypair: Keypair = ADMIN_KEYPAIR
): Promise<string> {
  const challengeResult = await createAdminChallenge(address);
  expect(challengeResult.status).toBe(200);
  const { challenge } = challengeResult.body as { challenge: string };

  const sig = Buffer.from(
    keypair.sign(Buffer.from(challenge, "utf8"))
  ).toString("base64");
  const verifyResult = await verifyAdminChallenge({
    address,
    challenge,
    signature: sig,
  });
  expect(verifyResult.status, "verify step must succeed").toBe(200);
  const { token } = verifyResult.body as { token: string };
  return `Bearer ${token}`;
}

// A contractId placeholder — only used as a parameter; actual on-chain reads
// are mocked out via fetchVaultAdmin above.
const CONTRACT_ID = "CBRAD5MD7CCXNXRLRGTRKG4NNZKR3N643VUEBNJGWB2L6KLZDLFWMXHQ";

// ---------------------------------------------------------------------------
// Set up environment and reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetAdminAuthForTesting();
  process.env.MERIDIAN_ADMIN_SESSION_SECRET =
    "test-secret-minimum-32-chars-long!!";
  process.env.MERIDIAN_VAULT_CONTRACT_ID = CONTRACT_ID;
  // Ensure we're in "local dev" mode so in-memory store is used.
  delete process.env.VERCEL_ENV;
  vi.clearAllMocks();
  vi.mocked(fetchVaultAdmin).mockResolvedValue(ADMIN_ADDRESS);
});

afterEach(() => {
  delete process.env.MERIDIAN_ADMIN_SESSION_SECRET;
  delete process.env.MERIDIAN_VAULT_CONTRACT_ID;
  delete process.env.VERCEL_ENV;
});

// ---------------------------------------------------------------------------
// createAdminChallenge
// ---------------------------------------------------------------------------

describe("createAdminChallenge", () => {
  it("returns a challenge string and expiry for a valid Stellar address", async () => {
    const result = await createAdminChallenge(ADMIN_ADDRESS);
    expect(result.status).toBe(200);
    const body = result.body as { challenge: string; expiresAt: number };
    expect(body.challenge).toMatch(/^meridian-admin-v1:/);
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns 400 for an invalid address", async () => {
    const result = await createAdminChallenge("not-a-stellar-address");
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe(
      "Invalid wallet address"
    );
  });

  it("embeds the address in the challenge string", async () => {
    const result = await createAdminChallenge(ADMIN_ADDRESS);
    const { challenge } = result.body as { challenge: string };
    expect(challenge).toContain(ADMIN_ADDRESS);
  });

  it("returns 503 when deployed but Redis is not configured", async () => {
    process.env.VERCEL_ENV = "production";
    // No Redis env vars set — putChallenge should throw.
    const result = await createAdminChallenge(ADMIN_ADDRESS);
    expect(result.status).toBe(503);
    expect((result.body as { error: string }).error).toBe(
      "Admin authentication unavailable"
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAdminChallenge
// ---------------------------------------------------------------------------

describe("verifyAdminChallenge", () => {
  it("returns a session token when signature and admin check pass", async () => {
    const challengeResult = await createAdminChallenge(ADMIN_ADDRESS);
    const { challenge } = challengeResult.body as { challenge: string };
    const signature = signChallenge(challenge);

    const result = await verifyAdminChallenge({
      address: ADMIN_ADDRESS,
      challenge,
      signature,
    });
    expect(result.status).toBe(200);
    const body = result.body as { token: string; expiresAt: number };
    expect(body.token).toMatch(/^[^.]+\.[^.]+$/);
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns 401 for a wrong signature", async () => {
    const challengeResult = await createAdminChallenge(ADMIN_ADDRESS);
    const { challenge } = challengeResult.body as { challenge: string };
    const wrongSignature = Buffer.from(new Uint8Array(64)).toString("base64");

    const result = await verifyAdminChallenge({
      address: ADMIN_ADDRESS,
      challenge,
      signature: wrongSignature,
    });
    expect(result.status).toBe(401);
  });

  it("returns 401 when the challenge has been consumed (replay protection)", async () => {
    const challengeResult = await createAdminChallenge(ADMIN_ADDRESS);
    const { challenge } = challengeResult.body as { challenge: string };
    const signature = signChallenge(challenge);

    await verifyAdminChallenge({
      address: ADMIN_ADDRESS,
      challenge,
      signature,
    });
    // Second attempt with the same challenge must fail.
    const replay = await verifyAdminChallenge({
      address: ADMIN_ADDRESS,
      challenge,
      signature,
    });
    expect(replay.status).toBe(401);
  });

  it("returns 401 for a challenge issued to a different address", async () => {
    const other = Keypair.random();
    const challengeResult = await createAdminChallenge(ADMIN_ADDRESS);
    const { challenge } = challengeResult.body as { challenge: string };
    // Sign with the other key — address mismatch with the stored record.
    const signature = Buffer.from(
      other.sign(Buffer.from(challenge, "utf8"))
    ).toString("base64");

    const result = await verifyAdminChallenge({
      address: other.publicKey(),
      challenge,
      signature,
    });
    expect(result.status).toBe(401);
  });

  it("returns 401 for an empty input", async () => {
    const result = await verifyAdminChallenge({
      address: "",
      challenge: "",
      signature: "",
    });
    expect(result.status).toBe(401);
  });

  it("returns 403 when the wallet is not the current vault admin", async () => {
    const notAdmin = Keypair.random();
    vi.mocked(fetchVaultAdmin).mockResolvedValueOnce(ADMIN_ADDRESS);

    const challengeResult = await createAdminChallenge(notAdmin.publicKey());
    const { challenge } = challengeResult.body as { challenge: string };
    const signature = Buffer.from(
      notAdmin.sign(Buffer.from(challenge, "utf8"))
    ).toString("base64");

    // fetchVaultAdmin returns ADMIN_ADDRESS, not notAdmin's key.
    const result = await verifyAdminChallenge({
      address: notAdmin.publicKey(),
      challenge,
      signature,
    });
    expect(result.status).toBe(403);
  });

  it("returns 503 when MERIDIAN_ADMIN_SESSION_SECRET is absent", async () => {
    delete process.env.MERIDIAN_ADMIN_SESSION_SECRET;
    const challengeResult = await createAdminChallenge(ADMIN_ADDRESS);
    const { challenge } = challengeResult.body as { challenge: string };
    const signature = signChallenge(challenge);

    const result = await verifyAdminChallenge({
      address: ADMIN_ADDRESS,
      challenge,
      signature,
    });
    expect(result.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// verifyAdmin
// ---------------------------------------------------------------------------

describe("verifyAdmin", () => {
  it("returns null (authorized) for a valid token when caller matches live admin", async () => {
    const authorization = await buildValidToken();
    const result = await verifyAdmin(CONTRACT_ID, authorization);
    expect(result).toBeNull();
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const result = await verifyAdmin(CONTRACT_ID, undefined);
    expect(result?.status).toBe(401);
  });

  it("returns 401 for a malformed token", async () => {
    const result = await verifyAdmin(CONTRACT_ID, "Bearer not-a-real-token");
    expect(result?.status).toBe(401);
  });

  it("returns 401 for a token with a tampered payload", async () => {
    const authorization = await buildValidToken();
    // Flip one character in the payload segment.
    const [, token] = authorization.split(" ");
    const [payload, sig] = token!.split(".");
    const tampered =
      payload!.slice(0, -1) + (payload!.endsWith("A") ? "B" : "A");
    const result = await verifyAdmin(CONTRACT_ID, `Bearer ${tampered}.${sig}`);
    expect(result?.status).toBe(401);
  });

  it("returns 403 when the session owner is no longer the vault admin", async () => {
    const authorization = await buildValidToken();
    // Simulate admin rotation — fetchVaultAdmin now returns a different key.
    vi.mocked(fetchVaultAdmin).mockResolvedValueOnce(
      Keypair.random().publicKey()
    );

    const result = await verifyAdmin(CONTRACT_ID, authorization);
    expect(result?.status).toBe(403);
  });

  it("returns 503 when the on-chain admin lookup fails", async () => {
    const authorization = await buildValidToken();
    const err = new Error("RPC unavailable");
    vi.mocked(fetchVaultAdmin).mockRejectedValueOnce(err);

    const result = await verifyAdmin(CONTRACT_ID, authorization);
    expect(result?.status).toBe(503);
    expect(result?.error).toBe(err);
  });

  it("returns 401 when MERIDIAN_ADMIN_SESSION_SECRET is absent", async () => {
    const authorization = await buildValidToken();
    delete process.env.MERIDIAN_ADMIN_SESSION_SECRET;

    const result = await verifyAdmin(CONTRACT_ID, authorization);
    expect(result?.status).toBe(401);
  });
});
