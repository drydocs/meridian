import { describe, it, expect } from "vitest";
import {
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_WINDOW_MS,
  buildRateLimitHeaders,
  combineRateLimitOutcomes,
  rateLimitBlockedBody,
  rateLimitIpKey,
  rateLimitWalletKey,
  resolveRateLimitPolicy,
  walletAddressFromBody,
  type RateLimitOutcome,
} from "./rate-limit.js";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function outcome(overrides: Partial<RateLimitOutcome> = {}): RateLimitOutcome {
  return {
    policy: "read",
    allowed: true,
    limit: 100,
    remaining: 99,
    resetMs: 60_000,
    windowMs: 60_000,
    ...overrides,
  };
}

describe("rate limit policy table (#1287)", () => {
  it("gives every route class its own entry", () => {
    expect(Object.keys(RATE_LIMIT_POLICIES).sort()).toEqual([
      "admin",
      "keeper",
      "keeperHealth",
      "read",
      "txBuild",
      "txSubmit",
    ]);
  });

  it("keeps the historical 100/min read allowance", () => {
    expect(RATE_LIMIT_POLICIES.read).toMatchObject({
      limit: 100,
      windowMs: RATE_LIMIT_WINDOW_MS,
      keyedByWallet: false,
    });
  });

  it("makes submit the strictest budget", () => {
    const { read, txBuild, txSubmit } = RATE_LIMIT_POLICIES;
    expect(txSubmit.limit).toBeLessThan(txBuild.limit);
    expect(txBuild.limit).toBeLessThan(read.limit);
  });

  it("keys transaction policies by wallet and leaves reads IP-only", () => {
    expect(RATE_LIMIT_POLICIES.txBuild.keyedByWallet).toBe(true);
    expect(RATE_LIMIT_POLICIES.txSubmit.keyedByWallet).toBe(true);
    expect(RATE_LIMIT_POLICIES.read.keyedByWallet).toBe(false);
    expect(RATE_LIMIT_POLICIES.admin.keyedByWallet).toBe(false);
  });

  it("fails closed only for fund-moving and keeper routes", () => {
    expect(RATE_LIMIT_POLICIES.txBuild.failClosed).toBe(true);
    expect(RATE_LIMIT_POLICIES.txSubmit.failClosed).toBe(true);
    expect(RATE_LIMIT_POLICIES.keeper.failClosed).toBe(true);
    expect(RATE_LIMIT_POLICIES.read.failClosed).toBe(false);
    expect(RATE_LIMIT_POLICIES.admin.failClosed).toBe(false);
    expect(RATE_LIMIT_POLICIES.keeperHealth.failClosed).toBe(false);
  });

  it("does not let the keeper health probe share the keeper budget", () => {
    expect(RATE_LIMIT_POLICIES.keeperHealth.failClosed).toBe(false);
    expect(RATE_LIMIT_POLICIES.keeper.limit).not.toBe(
      RATE_LIMIT_POLICIES.keeperHealth.limit
    );
  });
});

describe("resolveRateLimitPolicy", () => {
  it("returns the baseline when no overrides are set", () => {
    expect(resolveRateLimitPolicy("txSubmit", {})).toEqual(
      RATE_LIMIT_POLICIES.txSubmit
    );
  });

  it("applies a per-policy limit override", () => {
    expect(
      resolveRateLimitPolicy("txSubmit", { RATE_LIMIT_TX_SUBMIT_MAX: "5" })
    ).toMatchObject({ limit: 5 });
  });

  it("applies a per-policy window override", () => {
    expect(
      resolveRateLimitPolicy("read", { RATE_LIMIT_READ_WINDOW_MS: "1000" })
    ).toMatchObject({ windowMs: 1000 });
  });

  it("derives env names for camelCase policies", () => {
    expect(
      resolveRateLimitPolicy("keeperHealth", {
        RATE_LIMIT_KEEPER_HEALTH_MAX: "7",
      })
    ).toMatchObject({ limit: 7 });
    expect(
      resolveRateLimitPolicy("txBuild", { RATE_LIMIT_TX_BUILD_MAX: "3" })
    ).toMatchObject({ limit: 3 });
  });

  it("ignores invalid overrides rather than throwing", () => {
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      expect(
        resolveRateLimitPolicy("read", { RATE_LIMIT_READ_MAX: bad })
      ).toMatchObject({ limit: RATE_LIMIT_POLICIES.read.limit });
    }
  });

  it("does not mutate the shared table", () => {
    resolveRateLimitPolicy("read", { RATE_LIMIT_READ_MAX: "1" });
    expect(RATE_LIMIT_POLICIES.read.limit).toBe(100);
  });
});

describe("buildRateLimitHeaders", () => {
  it("describes the policy on an allowed request", () => {
    const headers = buildRateLimitHeaders(outcome({ remaining: 42 }));
    expect(headers).toMatchObject({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "42",
      "RateLimit-Reset": "60",
      "RateLimit-Policy": "100;w=60",
    });
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("adds Retry-After when blocked", () => {
    const headers = buildRateLimitHeaders(
      outcome({ allowed: false, remaining: 0, resetMs: 12_400 })
    );
    expect(headers["Retry-After"]).toBe("13");
    expect(headers["RateLimit-Remaining"]).toBe("0");
  });

  it("never reports a negative remaining", () => {
    expect(
      buildRateLimitHeaders(outcome({ remaining: -5 }))["RateLimit-Remaining"]
    ).toBe("0");
  });

  it("rounds a sub-second reset up to at least one second", () => {
    expect(
      buildRateLimitHeaders(outcome({ resetMs: 10 }))["RateLimit-Reset"]
    ).toBe("1");
  });
});

describe("rateLimitBlockedBody", () => {
  it("reports the wait and a machine-readable code", () => {
    const body = rateLimitBlockedBody(
      outcome({ allowed: false, remaining: 0, resetMs: 5_000 })
    );
    expect(body).toMatchObject({ code: "RATE_LIMITED", retryAfter: 5 });
    expect(body.error).toContain("5 seconds");
  });

  it("uses the singular for a one-second wait", () => {
    expect(
      rateLimitBlockedBody(outcome({ allowed: false, resetMs: 900 })).error
    ).toContain("1 second.");
  });
});

describe("bucket keys", () => {
  it("separates policies and key kinds", () => {
    expect(rateLimitIpKey("txSubmit", "1.2.3.4")).toBe("txSubmit:ip:1.2.3.4");
    expect(rateLimitWalletKey("txSubmit", WALLET)).toBe(
      `txSubmit:wallet:${WALLET}`
    );
    // The same IP has an independent budget per policy.
    expect(rateLimitIpKey("read", "1.2.3.4")).not.toBe(
      rateLimitIpKey("txSubmit", "1.2.3.4")
    );
  });
});

describe("combineRateLimitOutcomes", () => {
  it("allows only when both buckets allow", () => {
    const allowed = combineRateLimitOutcomes(
      outcome({ remaining: 10 }),
      outcome({ remaining: 20 })
    );
    expect(allowed.allowed).toBe(true);

    const blocked = combineRateLimitOutcomes(
      outcome({ remaining: 10 }),
      outcome({ allowed: false, remaining: 0 })
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("reports the tighter remaining budget and the later reset", () => {
    const merged = combineRateLimitOutcomes(
      outcome({ remaining: 5, resetMs: 30_000, limit: 30, policy: "txBuild" }),
      outcome({ remaining: 9, resetMs: 50_000, limit: 30, policy: "txBuild" })
    );
    expect(merged.remaining).toBe(5);
    expect(merged.resetMs).toBe(50_000);
  });
});

describe("walletAddressFromBody", () => {
  it("reads a valid wallet address", () => {
    expect(walletAddressFromBody({ walletAddress: WALLET })).toBe(WALLET);
  });

  it("ignores a malformed or missing address", () => {
    expect(walletAddressFromBody({ walletAddress: "not-a-key" })).toBe(
      undefined
    );
    expect(walletAddressFromBody({})).toBe(undefined);
    expect(walletAddressFromBody(null)).toBe(undefined);
    expect(walletAddressFromBody("string-body")).toBe(undefined);
  });
});
