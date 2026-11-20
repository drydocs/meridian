import {
  combineRateLimitOutcomes,
  rateLimitIpKey,
  rateLimitWalletKey,
  resolveRateLimitPolicy,
  type RateLimitOutcome,
  type RateLimitPolicy,
  type RateLimitPolicyName,
} from "./rate-limit";

/** One bucket's counter state, independent of where it is stored. */
export interface RateLimitCounter {
  count: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

/**
 * Backing store for the per-key counters. Implementations must be atomic per
 * key, since two concurrent requests from the same wallet or IP would
 * otherwise both read the same count and both be allowed.
 */
export interface RateLimitStore {
  increment(key: string, policy: RateLimitPolicy): Promise<RateLimitCounter>;
}

/**
 * Redis surface this module needs. Narrowed to the commands actually used so
 * both Upstash's REST client and ioredis can be passed in without api-core
 * depending on either driver.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

/**
 * Fixed-window counter in Redis. The window is (re)armed by the increment
 * that opens it, and a key whose expiry went missing is re-armed on the next
 * hit, so a counter can never stay pinned at its limit with no window left to
 * reset it.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

  async increment(
    key: string,
    policy: RateLimitPolicy
  ): Promise<RateLimitCounter> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.pexpire(key, policy.windowMs);
      return { count, resetMs: policy.windowMs };
    }
    let resetMs = await this.redis.pttl(key);
    if (resetMs < 0) {
      await this.redis.pexpire(key, policy.windowMs);
      resetMs = policy.windowMs;
    }
    return { count, resetMs };
  }
}

/**
 * Per-process fallback used when no Redis is configured (local dev, and any
 * non-strict read route on a deployment without Upstash). It is deliberately
 * not shared across instances, which is why fund-moving routes refuse to run
 * on it when a deployment is missing its credentials.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

  // Resolved per call rather than captured, so fake timers in tests (which
  // replace the global) still advance the window.
  constructor(private readonly now: () => number = () => Date.now()) {}

  async increment(
    key: string,
    policy: RateLimitPolicy
  ): Promise<RateLimitCounter> {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + policy.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { count: 1, resetMs: policy.windowMs };
    }
    existing.count += 1;
    return { count: existing.count, resetMs: existing.resetAt - now };
  }

  /** Drops every bucket. Exposed for tests only. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Counts one hit against a single key and shapes the result for the caller.
 * The counter is always incremented, even past the limit, so a client that
 * keeps hammering cannot step back under the limit by pausing briefly.
 */
export async function consumeRateLimitKey(
  store: RateLimitStore,
  policyName: RateLimitPolicyName,
  key: string,
  policy: RateLimitPolicy
): Promise<RateLimitOutcome> {
  const counter = await store.increment(key, policy);
  return {
    policy: policyName,
    allowed: counter.count <= policy.limit,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - counter.count),
    resetMs: Math.max(0, counter.resetMs),
    windowMs: policy.windowMs,
  };
}

export interface EvaluateRateLimitInput {
  store: RateLimitStore;
  policy: RateLimitPolicyName;
  ip: string;
  /** Only consulted for policies that are keyed by wallet. */
  wallet?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * The one place a request is actually counted, shared by the Vercel handlers
 * and the Fastify server so both enforce (and advertise) the same policy. The
 * IP bucket is always consumed; the wallet bucket is consumed only when the
 * policy is wallet-keyed and the request identifies a wallet, so a caller
 * without a wallet is limited by IP rather than exempted.
 */
export async function evaluateRateLimit({
  store,
  policy: policyName,
  ip,
  wallet,
  env = process.env,
}: EvaluateRateLimitInput): Promise<RateLimitOutcome> {
  const policy = resolveRateLimitPolicy(policyName, env);
  const ipOutcome = await consumeRateLimitKey(
    store,
    policyName,
    rateLimitIpKey(policyName, ip),
    policy
  );
  if (!policy.keyedByWallet || !wallet) return ipOutcome;

  const walletOutcome = await consumeRateLimitKey(
    store,
    policyName,
    rateLimitWalletKey(policyName, wallet),
    policy
  );
  return combineRateLimitOutcomes(ipOutcome, walletOutcome);
}
