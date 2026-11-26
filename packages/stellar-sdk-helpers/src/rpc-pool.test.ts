import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";
import * as internal from "./internal";
import {
  RpcAllEndpointsFailedError,
  isEndpointFailure,
  clearRpcHealthState,
  getRpcEndpointHealth,
  probeRpcEndpoint,
  probeRpcEndpoints,
  resolveRpcUrls,
  setRpcLogger,
  withRpcReadFailover,
  withRpcWrite,
  type RpcLogEntry,
} from "./rpc-pool";
import type { StellarNetwork } from "./types";

const PRIMARY = "https://rpc-primary.example";
const SECONDARY = "https://rpc-secondary.example";
const TERTIARY = "https://rpc-tertiary.example";

const NETWORK: StellarNetwork = {
  network: "mainnet",
  rpcUrl: PRIMARY,
  rpcUrls: [PRIMARY, SECONDARY, TERTIARY],
  passphrase: "Public Global Stellar Network ; September 2015",
};

function makeFakeServer(
  getLatestLedger: () => Promise<{ sequence: number }>
): rpc.Server {
  return { getLatestLedger } as unknown as rpc.Server;
}

describe("rpc-pool", () => {
  const logs: RpcLogEntry[] = [];

  beforeEach(() => {
    logs.length = 0;
    clearRpcHealthState();
    internal.clearRpcServerCache();
    setRpcLogger((entry) => logs.push(entry));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRpcLogger(undefined);
    clearRpcHealthState();
    internal.clearRpcServerCache();
  });

  describe("resolveRpcUrls", () => {
    it("resolves comma-separated strings, arrays, and StellarNetwork", () => {
      expect(resolveRpcUrls(` ${PRIMARY}, ${SECONDARY} , ${PRIMARY} `)).toEqual(
        [PRIMARY, SECONDARY]
      );
      expect(resolveRpcUrls([`${PRIMARY},${SECONDARY}`, TERTIARY])).toEqual([
        PRIMARY,
        SECONDARY,
        TERTIARY,
      ]);
      expect(resolveRpcUrls(NETWORK)).toEqual([PRIMARY, SECONDARY, TERTIARY]);
      expect(
        resolveRpcUrls({
          network: "testnet",
          rpcUrl: `${PRIMARY},${SECONDARY}`,
          passphrase: "test",
        })
      ).toEqual([PRIMARY, SECONDARY]);
    });

    it("throws when no valid URLs are provided", () => {
      expect(() => resolveRpcUrls(" , ")).toThrow(/No Soroban RPC URLs/);
    });
  });

  describe("health probing and getRpcEndpointHealth", () => {
    it("probes endpoints with getLatestLedger and records latency and failures", async () => {
      vi.spyOn(internal, "getRpcServer").mockImplementation((url) => {
        if (url === PRIMARY) {
          return makeFakeServer(async () => ({ sequence: 100 }));
        }
        return makeFakeServer(async () => {
          throw new Error("503 Service Unavailable");
        });
      });

      const results = await probeRpcEndpoints([PRIMARY, SECONDARY], {
        timeoutMs: 1_000,
      });

      expect(results).toHaveLength(2);
      const [first, second] = results;
      expect(first).toMatchObject({
        url: PRIMARY,
        healthy: true,
        recentFailures: 0,
        consecutiveFailures: 0,
        lastError: null,
      });
      expect(first?.latencyMs).toBeTypeOf("number");
      expect(first?.score).toBeGreaterThan(20);

      expect(second).toMatchObject({
        url: SECONDARY,
        healthy: false,
        recentFailures: 1,
        consecutiveFailures: 1,
        lastError: "503 Service Unavailable",
      });
      expect(second?.score).toBeLessThanOrEqual(20);

      // Health helper exposes snapshots for callers.
      const snapshot = getRpcEndpointHealth([PRIMARY, SECONDARY]);
      expect(snapshot.map((s) => s.healthy)).toEqual([true, false]);

      // Structured logs include endpoint, latency, and failure reason.
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: "rpc_probe",
          endpoint: PRIMARY,
          ok: true,
        })
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: "rpc_probe",
          endpoint: SECONDARY,
          ok: false,
          failureReason: "503 Service Unavailable",
        })
      );
    });
  });

  describe("read failover, recovery, and all-endpoints-down", () => {
    it("fails over from a failing primary to a healthy secondary within bounded timeout", async () => {
      vi.spyOn(internal, "getRpcServer").mockImplementation((url) =>
        makeFakeServer(async () => ({ sequence: url === SECONDARY ? 42 : 0 }))
      );

      const called: string[] = [];
      const result = await withRpcReadFailover(
        NETWORK,
        async (_server, url) => {
          called.push(url);
          if (url === PRIMARY) {
            throw new Error("ECONNRESET");
          }
          return `ok-from-${url}`;
        },
        { timeoutMs: 2_000 }
      );

      expect(result).toBe(`ok-from-${SECONDARY}`);
      expect(called).toEqual([PRIMARY, SECONDARY]);

      const health = getRpcEndpointHealth(NETWORK);
      expect(health[0]).toMatchObject({
        url: PRIMARY,
        healthy: false,
        consecutiveFailures: 1,
        lastError: "ECONNRESET",
      });
      expect(health[1]).toMatchObject({
        url: SECONDARY,
        healthy: true,
        consecutiveFailures: 0,
      });

      // Subsequent read goes directly to the healthy secondary first.
      called.length = 0;
      const secondResult = await withRpcReadFailover(
        NETWORK,
        async (_server, url) => {
          called.push(url);
          return `second-${url}`;
        },
        { timeoutMs: 2_000 }
      );
      expect(secondResult).toBe(`second-${SECONDARY}`);
      expect(called).toEqual([SECONDARY]);
    });

    it("recovers primary after it passes a health probe again", async () => {
      let primaryUp = false;
      vi.spyOn(internal, "getRpcServer").mockImplementation((url) =>
        makeFakeServer(async () => {
          if (url === PRIMARY && !primaryUp) {
            throw new Error("primary down");
          }
          return { sequence: 200 };
        })
      );

      // Primary fails initial probe.
      const badProbe = await probeRpcEndpoint(PRIMARY, { timeoutMs: 500 });
      expect(badProbe.healthy).toBe(false);

      // Read routes to secondary while primary is unhealthy.
      const seenBeforeRecovery: string[] = [];
      await withRpcReadFailover([PRIMARY, SECONDARY], async (_s, url) => {
        seenBeforeRecovery.push(url);
        return "ok";
      });
      expect(seenBeforeRecovery).toEqual([SECONDARY]);

      // Primary recovers and passes probe.
      primaryUp = true;
      const recovered = await probeRpcEndpoint(PRIMARY, { timeoutMs: 500 });
      expect(recovered.healthy).toBe(true);
      expect(recovered.consecutiveFailures).toBe(0);
      expect(recovered.lastError).toBeNull();

      const health = getRpcEndpointHealth([PRIMARY, SECONDARY]);
      expect(health[0]?.healthy).toBe(true);
      expect(health[1]?.healthy).toBe(true);
    });

    it("throws RpcAllEndpointsFailedError when all endpoints are down", async () => {
      vi.spyOn(internal, "getRpcServer").mockImplementation(() =>
        makeFakeServer(async () => ({ sequence: 0 }))
      );

      await expect(
        withRpcReadFailover(
          [PRIMARY, SECONDARY],
          async (_server, url) => {
            throw new Error(`ECONNRESET ${url}`);
          },
          { timeoutMs: 2_000 }
        )
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(RpcAllEndpointsFailedError);
        const failed = err as RpcAllEndpointsFailedError;
        expect(failed.attempts).toHaveLength(2);
        expect(failed.attempts.map((a) => a.endpoint)).toEqual([
          PRIMARY,
          SECONDARY,
        ]);
        expect(failed.attempts[0]?.reason).toBe(`ECONNRESET ${PRIMARY}`);
        expect(failed.attempts[1]?.reason).toBe(`ECONNRESET ${SECONDARY}`);
        return true;
      });
    });

    it("enforces bounded timeout when a primary hangs", async () => {
      vi.spyOn(internal, "getRpcServer").mockImplementation(() =>
        makeFakeServer(async () => ({ sequence: 0 }))
      );

      const startedAt = Date.now();
      const result = await withRpcReadFailover(
        [PRIMARY, SECONDARY],
        async (_server, url) => {
          if (url === PRIMARY) {
            return new Promise<string>(() => {
              // intentionally never resolves
            });
          }
          return "secondary-fast";
        },
        { timeoutMs: 500, perAttemptTimeoutMs: 60 }
      );

      expect(result).toBe("secondary-fast");
      expect(Date.now() - startedAt).toBeLessThan(500);
    });
  });

  describe("writes pinned to primary", () => {
    it("does not silently switch endpoints on write failure by default", async () => {
      vi.spyOn(internal, "getRpcServer").mockImplementation(() =>
        makeFakeServer(async () => ({ sequence: 0 }))
      );

      const called: string[] = [];
      await expect(
        withRpcWrite(NETWORK, async (_server, url) => {
          called.push(url);
          throw new Error("tx rejected");
        })
      ).rejects.toThrow("tx rejected");

      expect(called).toEqual([PRIMARY]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: "rpc_write",
          endpoint: PRIMARY,
          ok: false,
          failureReason: "tx rejected",
        })
      );
    });

    it("fails over writes only when caller explicitly sets allowFailover: true", async () => {
      vi.spyOn(internal, "getRpcServer").mockImplementation(() =>
        makeFakeServer(async () => ({ sequence: 0 }))
      );

      const called: string[] = [];
      const res = await withRpcWrite(
        [PRIMARY, SECONDARY],
        async (_server, url) => {
          called.push(url);
          if (url === PRIMARY) throw new Error("primary write timeout");
          return "submitted-on-secondary";
        },
        { allowFailover: true, timeoutMs: 2_000 }
      );

      expect(res).toBe("submitted-on-secondary");
      expect(called).toEqual([PRIMARY, SECONDARY]);
    });
  });
});

describe("rpc-pool application errors", () => {
  beforeEach(() => {
    clearRpcHealthState();
    internal.clearRpcServerCache();
    setRpcLogger(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRpcLogger(undefined);
    clearRpcHealthState();
    internal.clearRpcServerCache();
  });

  it("classifies transport errors as endpoint failures and contract errors as not", () => {
    expect(isEndpointFailure(new Error("ECONNRESET"))).toBe(true);
    expect(isEndpointFailure(new Error("request timed out"))).toBe(true);
    expect(isEndpointFailure(new Error("HTTP 503 from upstream"))).toBe(true);
    expect(isEndpointFailure(new Error("503 Service Unavailable"))).toBe(true);
    expect(isEndpointFailure({ response: { status: 502 } })).toBe(true);
    expect(isEndpointFailure({ response: { status: 429 } })).toBe(true);
    expect(isEndpointFailure({ response: { status: 400 } })).toBe(false);
    expect(isEndpointFailure(new Error("Error(Contract, #3)"))).toBe(false);
    expect(isEndpointFailure("simulation failed")).toBe(false);
  });

  it("rethrows an application error from a read without trying other endpoints", async () => {
    vi.spyOn(internal, "getRpcServer").mockImplementation(
      () => ({}) as unknown as rpc.Server
    );
    const contractError = new Error("Error(Contract, #3)");
    const called: string[] = [];

    await expect(
      withRpcReadFailover(NETWORK, async (_server, url) => {
        called.push(url);
        throw contractError;
      })
    ).rejects.toBe(contractError);

    expect(called).toEqual([PRIMARY]);
    expect(getRpcEndpointHealth(NETWORK).every((h) => h.healthy)).toBe(true);
  });

  it("rethrows an application error from a pinned write and keeps the endpoint healthy", async () => {
    vi.spyOn(internal, "getRpcServer").mockImplementation(
      () => ({}) as unknown as rpc.Server
    );
    const contractError = new Error("Error(Contract, #7)");

    await expect(
      withRpcWrite(NETWORK, async () => {
        throw contractError;
      })
    ).rejects.toBe(contractError);

    expect(getRpcEndpointHealth(NETWORK)[0]).toMatchObject({
      consecutiveFailures: 0,
    });
  });

  it("rethrows an application error from a write that allows failover", async () => {
    vi.spyOn(internal, "getRpcServer").mockImplementation(
      () => ({}) as unknown as rpc.Server
    );
    const contractError = new Error("Error(Contract, #7)");
    const called: string[] = [];

    await expect(
      withRpcWrite(
        NETWORK,
        async (_server, url) => {
          called.push(url);
          throw contractError;
        },
        { allowFailover: true }
      )
    ).rejects.toBe(contractError);

    expect(called).toEqual([PRIMARY]);
  });
});
