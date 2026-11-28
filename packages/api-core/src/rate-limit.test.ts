import { describe, it, expect, beforeEach } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { APP_NETWORK } from "@meridian/shared";
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  enforceRateLimit,
  rateLimitRouteForPath,
  resolveRateLimitPolicy,
  verifiedWalletFromRequest,
  verifiedWalletFromXdr,
  type RedisRateLimitClient,
} from "./rate-limit";

const WALLET_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WALLET_B = "GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH2BEWFG4BRUY4CKI7";

function paymentTx(source: string, networkPassphrase = APP_NETWORK.passphrase) {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: source,
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(30)
    .build();
}

describe("resolveRateLimitPolicy", () => {
  it("gives every route its own budget and keeps submits stricter than reads", () => {
    const read = resolveRateLimitPolicy("read", {});
    const build = resolveRateLimitPolicy("tx-build", {});
    const submit = resolveRateLimitPolicy("tx-submit", {});

    expect(read.walletScoped).toBe(false);
    expect(build.walletScoped).toBe(false);
    expect(submit.walletScoped).toBe(true);
    expect(submit.limit).toBeLessThan(read.limit);
    expect(submit.walletLimit).toBeLessThan(submit.limit);
    expect(build.limit).not.toBe(read.limit);
  });

  it("resolves keeper and admin policies", () => {
    const keeper = resolveRateLimitPolicy("keeper", {});
    const admin = resolveRateLimitPolicy("admin", {});

    expect(keeper).toMatchObject({ limit: 10, windowMs: 60_000, strict: true });
    expect(admin).toMatchObject({ limit: 60, walletScoped: false });
  });

  it("accepts per-route and per-wallet environment overrides", () => {
    const policy = resolveRateLimitPolicy("tx-submit", {
      RATE_LIMIT_TX_SUBMIT_LIMIT: "7",
      RATE_LIMIT_TX_SUBMIT_WALLET_LIMIT: "3",
      RATE_LIMIT_TX_SUBMIT_WINDOW_MS: "5000",
    });

    expect(policy.limit).toBe(7);
    expect(policy.walletLimit).toBe(3);
    expect(policy.windowMs).toBe(5000);
  });

  it("ignores empty and invalid overrides", () => {
    const policy = resolveRateLimitPolicy("read", {
      RATE_LIMIT_READ_LIMIT: "0",
      RATE_LIMIT_READ_WALLET_LIMIT: "not-a-number",
      RATE_LIMIT_READ_WINDOW_MS: "  ",
    });

    expect(policy.limit).toBe(100);
    expect(policy.walletLimit).toBe(100);
    expect(policy.windowMs).toBe(60_000);
  });
});

describe("rateLimitRouteForPath", () => {
  it.each([
    ["/api/v1/tx/submit", "tx-submit"],
    ["/api/v1/tx/deposit", "tx-build"],
    ["/api/v1/tx/withdraw", "tx-build"],
    ["/api/v1/keepers/accrue", "keeper"],
    ["/api/v1/keepers/health", "read"],
    ["/api/v1/keepers/health?verbose=1", "read"],
    ["/api/v1/admin/history", "admin"],
    ["/api/v1/vaults", "read"],
    ["/api/v1/positions/abc", "read"],
    ["/health", "read"],
  ] as const)("maps %s to %s", (path, route) => {
    expect(rateLimitRouteForPath(path)).toBe(route);
  });
});

describe("InMemoryRateLimitStore", () => {
  let now = 1_000_000;
  const store = new InMemoryRateLimitStore(() => now);

  beforeEach(() => {
    now = 1_000_000;
    store.reset();
  });

  it("allows the limit and blocks the next hit in the same window", async () => {
    const first = await store.hit("k", 2, 60_000);
    const second = await store.hit("k", 2, 60_000);
    const third = await store.hit("k", 2, 60_000);

    expect(first).toMatchObject({ allowed: true, remaining: 1 });
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    expect(third).toMatchObject({ allowed: false, remaining: 0 });
    expect(third.resetAt).toBe(first.resetAt);
  });

  it("starts a fresh window once the reset time passes", async () => {
    await store.hit("k", 1, 60_000);
    expect((await store.hit("k", 1, 60_000)).allowed).toBe(false);

    now += 60_000;
    const reset = await store.hit("k", 1, 60_000);
    expect(reset.allowed).toBe(true);
    expect(reset.remaining).toBe(0);
  });

  it("tracks different keys independently", async () => {
    await store.hit("a", 1, 60_000);
    expect((await store.hit("a", 1, 60_000)).allowed).toBe(false);
    expect((await store.hit("b", 1, 60_000)).allowed).toBe(true);
  });
});

class FakeRedis implements RedisRateLimitClient {
  readonly counts = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  calls = 0;

  /** Mirrors HIT_SCRIPT: INCR, then set the TTL when the key has none. */
  async eval(
    _script: string,
    keys: string[],
    args: (string | number)[]
  ): Promise<[number, number]> {
    this.calls += 1;
    const key = keys[0]!;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);

    let ttl = this.ttls.get(key) ?? -1;
    if (ttl < 0) {
      ttl = Number(args[0]);
      this.ttls.set(key, ttl);
    }
    return [count, ttl];
  }
}

describe("RedisRateLimitStore", () => {
  it("sets a TTL on the first hit and blocks over the limit", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis, () => 5_000);

    const first = await store.hit("k", 2, 30_000);
    const second = await store.hit("k", 2, 30_000);
    const third = await store.hit("k", 2, 30_000);

    expect(redis.ttls.get("k")).toBe(30_000);
    expect(first).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: 35_000,
    });
    expect(second.allowed).toBe(true);
    expect(third).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("spends one round trip per bucket", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis, () => 0);

    await store.hit("k", 2, 30_000);
    await store.hit("k", 2, 30_000);

    expect(redis.calls).toBe(2);
  });

  it("repairs a key that lost its TTL", async () => {
    const redis = new FakeRedis();
    redis.counts.set("k", 99);
    const store = new RedisRateLimitStore(redis, () => 0);

    const bucket = await store.hit("k", 10, 15_000);

    expect(redis.ttls.get("k")).toBe(15_000);
    expect(bucket.allowed).toBe(false);
    expect(bucket.resetAt).toBe(15_000);
  });

  it("falls back to the wall clock when no clock is injected", async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);

    const bucket = await store.hit("k", 1, 30_000);

    expect(bucket.resetAt).toBeGreaterThan(Date.now());
  });
});

describe("enforceRateLimit", () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it("emits RateLimit headers that match the read policy", async () => {
    const decision = await enforceRateLimit(
      store,
      "read",
      { ip: "1.2.3.4" },
      {}
    );

    expect(decision.allowed).toBe(true);
    expect(decision.headers["RateLimit-Limit"]).toBe("100");
    expect(decision.headers["RateLimit-Remaining"]).toBe("99");
    expect(decision.headers["RateLimit-Policy"]).toBe("100;w=60");
    expect(decision.headers["RateLimit-Reset"]).toMatch(/^\d+$/);
    expect(decision.headers["Retry-After"]).toBeUndefined();
  });

  it("blocks a wallet after its limit even when the IP changes", async () => {
    const env = { RATE_LIMIT_TX_SUBMIT_LIMIT: "100" };

    for (let i = 0; i < 5; i++) {
      const decision = await enforceRateLimit(
        store,
        "tx-submit",
        { ip: `10.0.0.${i}`, wallet: WALLET_A },
        env
      );
      expect(decision.allowed).toBe(true);
    }

    const blocked = await enforceRateLimit(
      store,
      "tx-submit",
      { ip: "10.0.0.99", wallet: WALLET_A },
      env
    );

    expect(blocked.allowed).toBe(false);
    expect(blocked.headers["RateLimit-Limit"]).toBe("5");
    expect(blocked.headers["RateLimit-Remaining"]).toBe("0");
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
  });

  it("does not let one wallet exhaust another wallet's budget", async () => {
    const env = { RATE_LIMIT_TX_SUBMIT_LIMIT: "100" };

    for (let i = 0; i < 5; i++) {
      await enforceRateLimit(
        store,
        "tx-submit",
        { ip: "10.0.0.1", wallet: WALLET_A },
        env
      );
    }

    const blocked = await enforceRateLimit(
      store,
      "tx-submit",
      { ip: "10.0.0.2", wallet: WALLET_A },
      env
    );
    const otherWallet = await enforceRateLimit(
      store,
      "tx-submit",
      { ip: "10.0.0.3", wallet: WALLET_B },
      env
    );

    expect(blocked.allowed).toBe(false);
    expect(otherWallet.allowed).toBe(true);
  });

  it("advertises the IP bucket when it is tighter than the wallet bucket", async () => {
    const env = {
      RATE_LIMIT_TX_SUBMIT_LIMIT: "2",
      RATE_LIMIT_TX_SUBMIT_WALLET_LIMIT: "100",
    };

    const decision = await enforceRateLimit(
      store,
      "tx-submit",
      { ip: "9.9.9.9", wallet: WALLET_A },
      env
    );

    expect(decision.buckets).toHaveLength(2);
    expect(decision.headers["RateLimit-Limit"]).toBe("2");
  });

  it("keeps transaction builds IP-only, ignoring a caller-supplied wallet", async () => {
    const env = { RATE_LIMIT_TX_BUILD_LIMIT: "100" };

    for (let i = 0; i < 15; i++) {
      const decision = await enforceRateLimit(
        store,
        "tx-build",
        { ip: `10.2.0.${i}`, wallet: WALLET_A },
        env
      );
      expect(decision.allowed).toBe(true);
      expect(decision.buckets).toHaveLength(1);
    }
  });

  it("gives a named bucket its own per-IP budget", async () => {
    const env = { RATE_LIMIT_READ_LIMIT: "1" };

    const bucketed = await enforceRateLimit(
      store,
      "read",
      { ip: "1.1.1.1", bucket: "csp-report" },
      env
    );
    const shared = await enforceRateLimit(
      store,
      "read",
      { ip: "1.1.1.1" },
      env
    );
    const blocked = await enforceRateLimit(
      store,
      "read",
      { ip: "1.1.1.1", bucket: "csp-report" },
      env
    );

    expect(bucketed.allowed).toBe(true);
    expect(shared.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
  });

  it("mirrors the standard headers under the legacy x-ratelimit names", async () => {
    const decision = await enforceRateLimit(store, "read", { ip: "2.2.2.2" });

    expect(decision.headers["x-ratelimit-limit"]).toBe(
      decision.headers["RateLimit-Limit"]
    );
    expect(decision.headers["x-ratelimit-remaining"]).toBe(
      decision.headers["RateLimit-Remaining"]
    );
  });

  it("still enforces the IP bucket on transaction routes", async () => {
    const env = { RATE_LIMIT_TX_BUILD_LIMIT: "2" };

    await enforceRateLimit(store, "tx-build", { ip: "1.1.1.1" }, env);
    await enforceRateLimit(store, "tx-build", { ip: "1.1.1.1" }, env);
    const blocked = await enforceRateLimit(
      store,
      "tx-build",
      { ip: "1.1.1.1" },
      env
    );

    expect(blocked.allowed).toBe(false);
    expect(blocked.headers["RateLimit-Limit"]).toBe("2");
  });
});

describe("verifiedWalletFromRequest", () => {
  it("returns the source account of a signed envelope", () => {
    const signer = Keypair.random();
    const tx = paymentTx(signer.publicKey());
    tx.sign(signer);

    expect(verifiedWalletFromXdr(tx.toXDR())).toBe(signer.publicKey());
    expect(verifiedWalletFromRequest({ xdr: tx.toXDR() })).toBe(
      signer.publicKey()
    );
  });

  it("ignores a walletAddress the caller did not prove", () => {
    expect(
      verifiedWalletFromRequest({ walletAddress: WALLET_A })
    ).toBeUndefined();
  });

  it("rejects an unsigned envelope", () => {
    expect(verifiedWalletFromXdr(paymentTx(WALLET_A).toXDR())).toBeUndefined();
  });

  it("rejects an envelope signed by a different key", () => {
    const signer = Keypair.random();
    const tx = paymentTx(WALLET_A);
    tx.sign(signer);

    expect(verifiedWalletFromXdr(tx.toXDR())).toBeUndefined();
  });

  it("reads the inner source of a signed fee-bump envelope", () => {
    const innerSigner = Keypair.random();
    const feeSource = Keypair.random();
    const inner = paymentTx(innerSigner.publicKey());
    inner.sign(innerSigner);

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource.publicKey(),
      "200",
      inner,
      APP_NETWORK.passphrase
    );
    feeBump.sign(feeSource);

    expect(verifiedWalletFromXdr(feeBump.toXDR())).toBe(
      innerSigner.publicKey()
    );
  });

  it("returns undefined for a non-object body and a non-string xdr", () => {
    expect(verifiedWalletFromRequest(null)).toBeUndefined();
    expect(verifiedWalletFromRequest("xdr")).toBeUndefined();
    expect(verifiedWalletFromRequest({ xdr: 42 })).toBeUndefined();
  });

  it("returns undefined for malformed XDR", () => {
    expect(verifiedWalletFromXdr("not-xdr")).toBeUndefined();
  });
});
