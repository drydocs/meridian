import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  fetchVaultAdmin,
  type CoordinatorConfig,
} from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";
import type { RouteResult } from "./types";

// Challenges expire in 5 minutes; sessions in 15 minutes. Both are
// deliberately short: challenges exist only so the wallet can sign them
// (one round-trip), and sessions are for in-flight dashboard reads only,
// not persistent logins. An admin rotation invalidates any existing
// session on the next protected request via the live get_admin() re-check.
const CHALLENGE_TTL_SECONDS = 5 * 60;
const SESSION_TTL_SECONDS = 15 * 60;
const SESSION_SECRET_ENV = "MERIDIAN_ADMIN_SESSION_SECRET";
const CHALLENGE_PREFIX = "meridian:admin:challenge:";
const ADMIN_LOOKUP_TIMEOUT_MS = 5_000;

interface ChallengeRecord {
  address: string;
  challenge: string;
  expiresAt: number;
}

// In-process store used when Redis is absent (local dev without VERCEL_ENV).
// Deliberately not exported: nothing outside this module should manipulate it
// directly.
const memoryChallenges = new Map<string, ChallengeRecord>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function redisConfig(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function redisCommand<T>(command: unknown[]): Promise<T> {
  const config = redisConfig();
  if (!config) throw new Error("Admin challenge store is not configured");
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("Admin challenge store unavailable");
  const body = (await response.json()) as { result?: T };
  return body.result as T;
}

async function putChallenge(
  nonce: string,
  record: ChallengeRecord
): Promise<void> {
  if (!redisConfig()) {
    // On any deployed environment (preview or production) Redis must be
    // present — challenges across serverless invocations need a shared store.
    if (process.env.VERCEL_ENV) {
      throw new Error("Admin challenge store is not configured");
    }
    memoryChallenges.set(nonce, record);
    return;
  }
  await redisCommand([
    "SET",
    `${CHALLENGE_PREFIX}${nonce}`,
    JSON.stringify(record),
    "EX",
    CHALLENGE_TTL_SECONDS,
  ]);
}

async function takeChallenge(nonce: string): Promise<ChallengeRecord | null> {
  let raw: string | null;
  if (!redisConfig()) {
    const record = memoryChallenges.get(nonce) ?? null;
    memoryChallenges.delete(nonce);
    raw = record ? JSON.stringify(record) : null;
  } else {
    // GETDEL is atomic in Redis: consume-and-delete in one call so a
    // challenge cannot be replayed even if a second request races in.
    raw = await redisCommand<string | null>([
      "GETDEL",
      `${CHALLENGE_PREFIX}${nonce}`,
    ]);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChallengeRecord;
  } catch {
    return null;
  }
}

function sessionSecret(): string | null {
  const secret = process.env[SESSION_SECRET_ENV]?.trim();
  return secret || null;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

// Compare two HMAC signatures in constant time to prevent timing attacks.
// Both inputs are already fixed-length base64url digests from the same
// HMAC call, so we hash neither one further — the length check up front
// would leak length information if the digests could ever differ in length,
// which they cannot when both come from the same sign() call. The check is
// retained as a correctness guard for any future caller that passes
// arbitrary strings.
function validSignature(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function validAddress(address: string): boolean {
  try {
    Keypair.fromPublicKey(address);
    return true;
  } catch {
    return false;
  }
}

async function fetchVaultAdminWithTimeout(contractId: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchVaultAdmin({
        contractId,
        network: APP_NETWORK,
      } satisfies CoordinatorConfig),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Admin lookup timed out")),
          ADMIN_LOOKUP_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issues a one-time challenge string for `address` to sign with its wallet.
 * The challenge is stored (Redis on deployed environments, in-process map
 * on local dev) and expires in CHALLENGE_TTL_SECONDS. The wallet signs the
 * raw UTF-8 challenge bytes; the resulting base64-encoded signature is passed
 * to verifyAdminChallenge together with this challenge string.
 */
export async function createAdminChallenge(
  address: string
): Promise<RouteResult> {
  if (!validAddress(address)) {
    return { status: 400, body: { error: "Invalid wallet address" } };
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + CHALLENGE_TTL_SECONDS;
  const nonce = randomBytes(32).toString("hex");
  const challenge = `meridian-admin-v1:${address}:${nonce}:${expiresAt}`;
  try {
    await putChallenge(nonce, { address, challenge, expiresAt });
    return { status: 200, body: { challenge, expiresAt } };
  } catch (err) {
    return {
      status: 503,
      body: { error: "Admin authentication unavailable" },
      error: err,
    };
  }
}

/**
 * Verifies that the wallet at `address` signed `challenge` (returned by
 * createAdminChallenge), then re-reads the vault's live `get_admin()` to
 * confirm `address` is currently the admin. On success returns a short-lived
 * HMAC-signed session token.
 *
 * The challenge is consumed on first use — replaying the same challenge +
 * signature fails immediately.
 */
export async function verifyAdminChallenge(input: {
  address: string;
  challenge: string;
  signature: string;
}): Promise<RouteResult> {
  if (!validAddress(input.address) || !input.challenge || !input.signature) {
    return { status: 401, body: { error: "Invalid admin proof" } };
  }
  const secret = sessionSecret();
  if (!secret) {
    return { status: 503, body: { error: "Admin authentication unavailable" } };
  }
  const nonce = input.challenge.split(":")[2];
  if (!nonce) return { status: 401, body: { error: "Invalid admin proof" } };

  try {
    const record = await takeChallenge(nonce);
    const now = Math.floor(Date.now() / 1000);
    if (
      !record ||
      record.address !== input.address ||
      record.challenge !== input.challenge ||
      record.expiresAt <= now
    ) {
      return {
        status: 401,
        body: { error: "Invalid or expired admin proof" },
      };
    }

    const signature = Buffer.from(input.signature, "base64");
    // Ed25519 signatures are always 64 bytes.
    if (signature.length !== 64) {
      return { status: 401, body: { error: "Invalid admin proof" } };
    }
    const verified = Keypair.fromPublicKey(input.address).verify(
      Buffer.from(input.challenge, "utf8"),
      signature
    );
    if (!verified) {
      return { status: 401, body: { error: "Invalid admin proof" } };
    }

    // Re-check live admin at verify time as well, so a rotation that happens
    // between challenge and verify is caught here rather than only on the
    // first protected request.
    const admin = await fetchVaultAdminWithTimeout(
      process.env.MERIDIAN_VAULT_CONTRACT_ID ?? ""
    );
    if (input.address !== admin) {
      return { status: 403, body: { error: "Admin access required" } };
    }

    const expiresAt = now + SESSION_TTL_SECONDS;
    const payload = encode(
      JSON.stringify({ sub: input.address, exp: expiresAt })
    );
    return {
      status: 200,
      body: { token: `${payload}.${sign(payload, secret)}`, expiresAt },
    };
  } catch (err) {
    return {
      status: 401,
      body: { error: "Invalid admin proof" },
      error: err,
    };
  }
}

/**
 * Decodes and verifies the HMAC-signed session token from an `Authorization:
 * Bearer <token>` header. Returns the embedded address on success, or null
 * if the token is absent, malformed, expired, or the signature does not
 * match.
 */
function verifiedAddress(authorization: string | undefined): string | null {
  const secret = sessionSecret();
  if (!secret || !authorization) return null;

  const parts = authorization.split(" ");
  const bearer =
    parts.length === 2 && parts[0] === "Bearer"
      ? (parts[1] ?? "")
      : authorization;

  const segments = bearer.split(".");
  if (segments.length !== 2) return null;
  const [payload, signature] = segments as [string, string];

  if (!validSignature(signature, sign(payload, secret))) return null;

  const decoded = decode(payload);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as { sub?: string; exp?: number };
    if (
      !parsed.sub ||
      !parsed.exp ||
      parsed.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return validAddress(parsed.sub) ? parsed.sub : null;
  } catch {
    return null;
  }
}

/**
 * Gate for every protected admin endpoint. Decodes and verifies the session
 * token, then re-reads `get_admin()` on every call so an admin rotation
 * immediately invalidates the old admin's access — even before the session
 * would naturally expire.
 *
 * Returns null when the caller is authorized (proceed with the handler),
 * or a RouteResult with the appropriate error status to return immediately.
 */
export async function verifyAdmin(
  contractId: string,
  authorization: string | undefined
): Promise<RouteResult | null> {
  const address = verifiedAddress(authorization);
  if (!address) {
    return { status: 401, body: { error: "Admin authentication required" } };
  }
  try {
    const admin = await fetchVaultAdminWithTimeout(contractId);
    if (address !== admin) {
      return { status: 403, body: { error: "Admin access required" } };
    }
    return null;
  } catch (err) {
    return {
      status: 503,
      body: { error: "Admin authentication unavailable" },
      error: err,
    };
  }
}

/** Clears the in-memory challenge store. Exposed for tests only. */
export function resetAdminAuthForTesting(): void {
  memoryChallenges.clear();
}
