import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  consumeRateLimitKey,
  evaluateRateLimit,
  type RedisLike,
} from "./rate-limit-store.js";
import { RATE_LIMIT_POLICIES, resolveRateLimitPolicy } from "./rate-limit.js";

const WALLET_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WALLET_B = "GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG";

/** Minimal in-memory stand-in for the Redis commands the store uses. */
class FakeRedis implements RedisLike {
  readonly values = new Map<
    string,
    { count: number; expiresAt?: number | undefined }
  >();
  now = 0;

  private live(key: string) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  async incr(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) {
      this.values.set(key, { count: 1 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  async pexpire(key: string, ms: number): Promise<unknown> {
    const entry = this.values.get(key);
    if (!entry) return 0;
    entry.expiresAt = this.now + ms;
    return 1;
  }

  async pttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return entry.expiresAt - this.now;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryRateLimitStore", () => {
  it("counts hits inside one window", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = {
      limit: 3,
      windowMs: 1000,
      keyedByWallet: false,
      failClosed: false,
    };
    expect((await store.increment("k", policy)).count).toBe(1);
    expect((await store.increment("k", policy)).count).toBe(2);
    expect((await store.increment("k", policy)).count).toBe(3);
  });

  it("resets once the window expires", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = {
      limit: 2,
      windowMs: 1000,
      keyedByWallet: false,
      failClosed: false,
    };
    await store.increment("k", policy);
    await store.increment("k", policy);
    vi.advanceTimersByTime(1001);
    expect((await store.increment("k", policy)).count).toBe(1);
  });

  it("keeps buckets independent per key", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = {
      limit: 5,
      windowMs: 1000,
      keyedByWallet: false,
      failClosed: false,
    };
    await store.increment("a", policy);
    await store.increment("a", policy);
    expect((await store.increment("b", policy)).count).toBe(1);
  });

  it("clear() drops every bucket", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = {
      limit: 5,
      windowMs: 1000,
      keyedByWallet: false,
      failClosed: false,
    };
    await store.increment("a", policy);
    store.reset();
    expect((await store.increment("a", policy)).count).toBe(1);
  });
});

describe("RedisRateLimitStore", () => {
  it("arms the window on the first increment", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    const policy = {
      limit: 5,
      windowMs: 2000,
      keyedByWallet: false,
      failClosed: false,
    };
    expect(await store.increment("k", policy)).toEqual({
      count: 1,
      resetMs: 2000,
    });
    expect(await redis.pttl("k")).toBe(2000);
  });

  it("reports the remaining window on later increments", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    const policy = {
      limit: 5,
      windowMs: 2000,
      keyedByWallet: false,
      failClosed: false,
    };
    await store.increment("k", policy);
    redis.now = 500;
    expect(await store.increment("k", policy)).toEqual({
      count: 2,
      resetMs: 1500,
    });
  });

  it("re-arms a key whose expiry went missing", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    const policy = {
      limit: 5,
      windowMs: 2000,
      keyedByWallet: false,
      failClosed: false,
    };
    await store.increment("k", policy);
    // Simulate a lost TTL: no expiry set, so pttl reports -1.
    redis.values.get("k")!.expiresAt = undefined;
    expect(await store.increment("k", policy)).toEqual({
      count: 2,
      resetMs: 2000,
    });
  });
});

describe("consumeRateLimitKey", () => {
  it("blocks once the count passes the limit", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = {
      limit: 2,
      windowMs: 60_000,
      keyedByWallet: false,
      failClosed: false,
    };
    expect(
      (await consumeRateLimitKey(store, "read", "k", policy)).allowed
    ).toBe(true);
    expect(
      (await consumeRateLimitKey(store, "read", "k", policy)).allowed
    ).toBe(true);
    const blocked = await consumeRateLimitKey(store, "read", "k", policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("keeps counting past the limit so a pause cannot reset the budget", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = {
      limit: 1,
      windowMs: 60_000,
      keyedByWallet: false,
      failClosed: false,
    };
    await consumeRateLimitKey(store, "read", "k", policy);
    await consumeRateLimitKey(store, "read", "k", policy);
    const third = await consumeRateLimitKey(store, "read", "k", policy);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });
});

describe("evaluateRateLimit", () => {
  const env = {
    RATE_LIMIT_TX_SUBMIT_MAX: "2",
    RATE_LIMIT_TX_SUBMIT_WINDOW_MS: "60000",
  };

  it("limits read traffic by IP only", async () => {
    const store = new InMemoryRateLimitStore();
    const outcome = await evaluateRateLimit({
      store,
      policy: "read",
      ip: "1.2.3.4",
      wallet: WALLET_A,
      env,
    });
    expect(outcome.policy).toBe("read");
    expect(outcome.limit).toBe(RATE_LIMIT_POLICIES.read.limit);
  });

  it("counts a wallet-keyed request against both its IP and its wallet", async () => {
    const store = new InMemoryRateLimitStore();
    const first = await evaluateRateLimit({
      store,
      policy: "txSubmit",
      ip: "1.2.3.4",
      wallet: WALLET_A,
      env,
    });
    expect(first.allowed).toBe(true);
    // Same wallet from a new IP: the wallet bucket is already at its limit.
    const second = await evaluateRateLimit({
      store,
      policy: "txSubmit",
      ip: "5.6.7.8",
      wallet: WALLET_A,
      env,
    });
    expect(second.allowed).toBe(true);
    const third = await evaluateRateLimit({
      store,
      policy: "txSubmit",
      ip: "9.9.9.9",
      wallet: WALLET_A,
      env,
    });
    expect(third.allowed).toBe(false);
  });

  it("counts a different wallet independently on the same IP", async () => {
    const store = new InMemoryRateLimitStore();
    // Budget of 4 so the shared IP bucket still has room for wallet B; this
    // isolates the wallet buckets from the IP bucket.
    const roomyEnv = { RATE_LIMIT_TX_SUBMIT_MAX: "4" };
    for (let i = 0; i < 2; i++) {
      await evaluateRateLimit({
        store,
        policy: "txSubmit",
        ip: "1.2.3.4",
        wallet: WALLET_A,
        env: roomyEnv,
      });
    }
    const other = await evaluateRateLimit({
      store,
      policy: "txSubmit",
      ip: "1.2.3.4",
      wallet: WALLET_B,
      env: roomyEnv,
    });
    expect(other.allowed).toBe(true);
    // Wallet B still has its own budget; the reported remaining is the shared
    // IP bucket's, which is the tighter of the two.
    expect(other.remaining).toBe(1);
  });

  it("falls back to IP-only limiting when a wallet-keyed request has no wallet", async () => {
    const store = new InMemoryRateLimitStore();
    const outcome = await evaluateRateLimit({
      store,
      policy: "txSubmit",
      ip: "1.2.3.4",
      env,
    });
    expect(outcome.allowed).toBe(true);
    expect(outcome.limit).toBe(2);
  });

  it("does not let read traffic consume a transaction budget", async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < RATE_LIMIT_POLICIES.read.limit; i++) {
      await evaluateRateLimit({
        store,
        policy: "read",
        ip: "1.2.3.4",
        env: {},
      });
    }
    const submit = await evaluateRateLimit({
      store,
      policy: "txSubmit",
      ip: "1.2.3.4",
      wallet: WALLET_A,
      env: {},
    });
    expect(submit.allowed).toBe(true);
    expect(submit.limit).toBe(resolveRateLimitPolicy("txSubmit", {}).limit);
  });
});
