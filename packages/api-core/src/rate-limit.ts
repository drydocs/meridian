import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { APP_NETWORK } from "@meridian/shared";

/**
 * Traffic classes that get their own bucket. Reads and fund-moving routes must
 * not compete for the same budget: a burst of transaction submissions should
 * not exhaust the budget the dashboard needs to render balances.
 */
export type RateLimitRoute =
  "read" | "tx-build" | "tx-submit" | "keeper" | "admin";

export interface RateLimitPolicy {
  readonly route: RateLimitRoute;
  /** Requests allowed per window for one client IP. */
  readonly limit: number;
  /** Requests allowed per window for one wallet, on wallet-scoped routes. */
  readonly walletLimit: number;
  readonly windowMs: number;
  /**
   * Adds a wallet bucket on routes whose request proves the wallet with a
   * signed transaction. Build requests carry an unsigned `walletAddress`, so
   * they stay IP-only: any caller can name any address.
   */
  readonly walletScoped: boolean;
  /** Requires a distributed store on deployed environments. */
  readonly strict: boolean;
}

const DEFAULT_POLICIES: Readonly<Record<RateLimitRoute, RateLimitPolicy>> = {
  read: {
    route: "read",
    limit: 100,
    walletLimit: 100,
    windowMs: 60_000,
    walletScoped: false,
    strict: false,
  },
  "tx-build": {
    route: "tx-build",
    limit: 30,
    walletLimit: 15,
    windowMs: 60_000,
    walletScoped: false,
    strict: true,
  },
  "tx-submit": {
    route: "tx-submit",
    limit: 10,
    walletLimit: 5,
    windowMs: 60_000,
    walletScoped: true,
    strict: true,
  },
  keeper: {
    route: "keeper",
    limit: 10,
    walletLimit: 10,
    windowMs: 60_000,
    walletScoped: false,
    strict: true,
  },
  admin: {
    route: "admin",
    limit: 60,
    walletLimit: 60,
    windowMs: 60_000,
    walletScoped: false,
    strict: true,
  },
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envPrefix(route: RateLimitRoute): string {
  return `RATE_LIMIT_${route.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * Resolves the policy for a route, applying per-route environment overrides:
 * `RATE_LIMIT_<ROUTE>_LIMIT`, `RATE_LIMIT_<ROUTE>_WALLET_LIMIT`, and
 * `RATE_LIMIT_<ROUTE>_WINDOW_MS` (for example `RATE_LIMIT_TX_SUBMIT_LIMIT`).
 */
export function resolveRateLimitPolicy(
  route: RateLimitRoute,
  env: Record<string, string | undefined> = process.env
): RateLimitPolicy {
  const base = DEFAULT_POLICIES[route];
  const prefix = envPrefix(route);
  return {
    route,
    limit: positiveInt(env[`${prefix}_LIMIT`], base.limit),
    walletLimit: positiveInt(env[`${prefix}_WALLET_LIMIT`], base.walletLimit),
    windowMs: positiveInt(env[`${prefix}_WINDOW_MS`], base.windowMs),
    walletScoped: base.walletScoped,
    strict: base.strict,
  };
}

/** Maps a request path to the policy that should govern it. */
export function rateLimitRouteForPath(path: string): RateLimitRoute {
  const pathname = path.split("?")[0] ?? path;
  if (pathname.startsWith("/api/v1/tx/submit")) return "tx-submit";
  if (pathname.startsWith("/api/v1/tx/")) return "tx-build";
  // Keeper health is a public read served by the same handler as the cron
  // actions, and that handler charges it to the read policy.
  if (pathname.startsWith("/api/v1/keepers/health")) return "read";
  if (pathname.startsWith("/api/v1/keepers/")) return "keeper";
  if (pathname.startsWith("/api/v1/admin/")) return "admin";
  return "read";
}

export interface RateLimitBucket {
  readonly key: string;
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets. */
  readonly resetAt: number;
}

/**
 * Minimal counter store. The Vercel handlers back this with Upstash and the
 * local Fastify server with ioredis; both keep their existing Redis client.
 */
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitBucket>;
}

interface MemoryEntry {
  count: number;
  resetAt: number;
}

/** Fixed-window fallback used in local dev and tests. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, MemoryEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async hit(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitBucket> {
    const now = this.now();
    const entry = this.buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return {
        key,
        allowed: limit >= 1,
        limit,
        remaining: Math.max(0, limit - 1),
        resetAt,
      };
    }

    entry.count += 1;
    return {
      key,
      allowed: entry.count <= limit,
      limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Increments the bucket and returns `[count, ttlMs]` in one round trip.
 * Separate INCR/PEXPIRE/PTTL commands cost three REST requests per bucket on
 * Upstash, and a wallet-scoped submit spends two buckets.
 */
const HIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  -- A key without a TTL (for example after a crash between INCR and PEXPIRE)
  -- would otherwise stay blocked forever.
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * The one command the counter store needs. Upstash takes this shape as is;
 * ioredis takes `eval(script, numKeys, ...keysAndArgs)`, so its callers adapt.
 */
export interface RedisRateLimitClient {
  eval(
    script: string,
    keys: string[],
    args: (string | number)[]
  ): Promise<unknown>;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: RedisRateLimitClient,
    private readonly now: () => number = () => Date.now()
  ) {}

  async hit(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitBucket> {
    const [count, ttl] = (await this.redis.eval(
      HIT_SCRIPT,
      [key],
      [windowMs]
    )) as [number, number];

    return {
      key,
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: this.now() + ttl,
    };
  }
}

export interface RateLimitRequest {
  ip: string;
  wallet?: string | undefined;
  /**
   * Optional counter namespace. Routes that pass one get their own per-IP
   * budget instead of sharing the route default, so noisy low-value traffic
   * cannot starve the routes beside it.
   */
  bucket?: string | undefined;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly route: RateLimitRoute;
  readonly policy: RateLimitPolicy;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
  readonly headers: Record<string, string>;
  readonly buckets: readonly RateLimitBucket[];
}

/**
 * Applies a route policy to one request. The IP bucket always applies. On
 * wallet-scoped routes a proven wallet is a second bucket, so rotating IPs
 * does not reset a wallet's budget. The tightest bucket drives the advertised
 * headers.
 */
export async function enforceRateLimit(
  store: RateLimitStore,
  route: RateLimitRoute,
  request: RateLimitRequest,
  env: Record<string, string | undefined> = process.env
): Promise<RateLimitDecision> {
  const policy = resolveRateLimitPolicy(route, env);

  const ipKey = request.bucket ? `${request.bucket}:${request.ip}` : request.ip;
  const buckets: RateLimitBucket[] = [
    await store.hit(`rl:${route}:ip:${ipKey}`, policy.limit, policy.windowMs),
  ];
  if (policy.walletScoped && request.wallet) {
    buckets.push(
      await store.hit(
        `rl:${route}:wallet:${request.wallet}`,
        policy.walletLimit,
        policy.windowMs
      )
    );
  }

  const [first, ...rest] = buckets;
  const primary = rest.reduce(
    (tightest, bucket) =>
      bucket.remaining < tightest.remaining ? bucket : tightest,
    first!
  );
  const allowed = buckets.every((bucket) => bucket.allowed);
  const now = Date.now();
  const resetAt = Math.max(...buckets.map((bucket) => bucket.resetAt));
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  const windowSeconds = Math.max(1, Math.ceil(policy.windowMs / 1000));

  const resetSeconds = String(
    Math.max(0, Math.ceil((primary.resetAt - now) / 1000))
  );
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(primary.limit),
    "RateLimit-Remaining": String(primary.remaining),
    "RateLimit-Reset": resetSeconds,
    "RateLimit-Policy": `${primary.limit};w=${windowSeconds}`,
    // Deployed clients and the conformance suite still read the legacy
    // x-ratelimit-* names, so both surfaces emit both spellings.
    "x-ratelimit-limit": String(primary.limit),
    "x-ratelimit-remaining": String(primary.remaining),
    "x-ratelimit-reset": resetSeconds,
  };
  if (!allowed) headers["Retry-After"] = String(retryAfterSeconds);

  return {
    allowed,
    route,
    policy,
    limit: primary.limit,
    remaining: primary.remaining,
    resetAt: primary.resetAt,
    retryAfterSeconds,
    headers,
    buckets,
  };
}

/**
 * Extracts the wallet that should own the wallet bucket from a submit request.
 * Only the signed XDR names a wallet: the request body is caller-controlled, so
 * a `walletAddress` field would let anyone spend another wallet's budget.
 */
export function verifiedWalletFromRequest(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;

  const xdr = (body as Record<string, unknown>)["xdr"];
  return typeof xdr === "string" ? verifiedWalletFromXdr(xdr) : undefined;
}

/**
 * Returns the source account of a transaction envelope, but only when that
 * account signed it. The signature is what proves the caller controls the
 * wallet being rate limited; an unsigned or third-party envelope yields
 * nothing and the request falls back to its IP bucket alone.
 */
export function verifiedWalletFromXdr(xdr: string): string | undefined {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, APP_NETWORK.passphrase);
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const signer = Keypair.fromPublicKey(inner.source);
    const hash = inner.hash();
    const signed = inner.signatures.some((signature) =>
      signer.verify(hash, signature.signature())
    );
    return signed ? inner.source : undefined;
  } catch {
    return undefined;
  }
}
