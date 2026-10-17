import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  fetchVaultAdmin,
  type CoordinatorConfig,
} from "@meridian/stellar-sdk-helpers";
import { APP_NETWORK } from "@meridian/shared";
import type { RouteResult } from "./types";

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

const memoryChallenges = new Map<string, ChallengeRecord>();

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
  /* c8 ignore next -- callers check redisConfig before issuing commands. */
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

async function putChallenge(nonce: string, record: ChallengeRecord) {
  if (!redisConfig()) {
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
    // GETDEL is atomic in Redis and makes a challenge strictly single-use.
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

function validSignature(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
    /* c8 ignore next -- the Promise constructor always assigns this timer. */
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
      return { status: 401, body: { error: "Invalid or expired admin proof" } };
    }

    const signature = Buffer.from(input.signature, "base64");
    if (signature.length !== 64) {
      return { status: 401, body: { error: "Invalid admin proof" } };
    }
    const verified = Keypair.fromPublicKey(input.address).verify(
      Buffer.from(input.challenge, "utf8"),
      signature
    );
    if (!verified)
      return { status: 401, body: { error: "Invalid admin proof" } };

    const expiresAt = now + SESSION_TTL_SECONDS;
    const payload = encode(
      JSON.stringify({ sub: input.address, exp: expiresAt })
    );
    return {
      status: 200,
      body: { token: `${payload}.${sign(payload, secret)}`, expiresAt },
    };
  } catch (err) {
    return { status: 401, body: { error: "Invalid admin proof" }, error: err };
  }
}

function verifiedAddress(token: string | undefined): string | null {
  const secret = sessionSecret();
  if (!secret || !token) return null;
  const parts = token.split(" ");
  /* c8 ignore next -- a two-part token always has a second array element. */
  const bearer =
    parts.length === 2 && parts[0] === "Bearer" ? (parts[1] ?? "") : token;
  const segments = bearer.split(".");
  if (segments.length !== 2) return null;
  const [payload, signature] = segments;
  if (!validSignature(signature!, sign(payload!, secret))) return null;
  const decoded = decode(payload!);
  /* c8 ignore next -- Buffer decoding does not throw for base64url input. */
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as { sub?: string; exp?: number };
    if (
      !parsed.sub ||
      !parsed.exp ||
      parsed.exp <= Math.floor(Date.now() / 1000)
    )
      return null;
    return validAddress(parsed.sub) ? parsed.sub : null;
  } catch {
    return null;
  }
}

/** Verifies the signed session, then re-reads get_admin() for every request. */
export async function verifyAdmin(
  contractId: string,
  authorization: string | undefined
): Promise<RouteResult | null> {
  const address = verifiedAddress(authorization);
  if (!address) return { status: 401, body: { error: "Invalid admin proof" } };
  try {
    const admin = await fetchVaultAdminWithTimeout(contractId);
    if (address !== admin)
      return { status: 403, body: { error: "Admin access required" } };
    return null;
  } catch (err) {
    return {
      status: 503,
      body: { error: "Admin authentication unavailable" },
      error: err,
    };
  }
}

export function resetAdminAuthForTesting(): void {
  memoryChallenges.clear();
}
