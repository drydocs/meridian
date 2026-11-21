import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@meridian/stellar-sdk-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@meridian/stellar-sdk-helpers")>();
  return { ...actual, prepareSorobanTx: vi.fn(), simulateView: vi.fn() };
});

import {
  ContractSimulationError,
  prepareSorobanTx,
  simulateView,
} from "@meridian/stellar-sdk-helpers";
import { VaultBase } from "./vault-base.js";
import {
  NetworkError,
  SlippageError,
  TimeoutError,
  UnsupportedError,
  ValidationError,
} from "./errors.js";
import { REDACTED } from "./instrumentation.js";
import type { VaultConfig } from "./types.js";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const BASE: VaultConfig = {
  contractId: "CAIQBVLBIUWQGE6DQUHDMZ2QWI7QP6KTCN7GP2BIZ6JZC4ES47JO4SSM",
  network: {
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  },
};

class TestVault extends VaultBase {
  protected get caller() {
    return WALLET;
  }
  protected override makeRpcServer() {
    return {} as never;
  }
}

const sim = vi.mocked(simulateView);
const prep = vi.mocked(prepareSorobanTx);

beforeEach(() => {
  vi.resetAllMocks();
  prep.mockResolvedValue({ xdr: "X", fee: "1" });
});

describe("typed validation errors", () => {
  it("are ValidationErrors with stable codes", async () => {
    const v = new TestVault(BASE);
    const e = await v.deposit(0n, WALLET).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e).toMatchObject({ code: "VALIDATION", retryable: false });
    await expect(v.withdraw(1n, OTHER, WALLET)).rejects.toBeInstanceOf(
      ValidationError
    );
    await expect(v.migrateAdapter(OTHER, 9999)).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("reports an empty vault as UnsupportedError", async () => {
    sim.mockResolvedValue(0n);
    await expect(
      new TestVault(BASE).withdraw(1n, WALLET, WALLET)
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("rejects non-positive timeouts at construction", () => {
    expect(() => new TestVault({ ...BASE, timeouts: { rpcMs: 0 } })).toThrow(
      ValidationError
    );
    expect(
      () => new TestVault({ ...BASE, timeouts: { operationMs: Number.NaN } })
    ).toThrow("timeouts.operationMs must be a positive number");
  });
});

describe("classification of network-layer failures", () => {
  it("surfaces slippage as SlippageError (message and cause preserved)", async () => {
    const src = new ContractSimulationError(18, "Error(Contract, #18)");
    prep.mockRejectedValue(src);
    const e = await new TestVault(BASE)
      .deposit(5n, WALLET)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SlippageError);
    expect((e as Error).message).toBe(src.message);
    expect((e as SlippageError).cause).toBe(src);
  });

  it("surfaces transport failures as retryable NetworkError", async () => {
    sim.mockRejectedValue(new Error("fetch failed"));
    const e = await new TestVault(BASE).totalAssets().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as NetworkError).retryable).toBe(true);
  });
});

describe("timeouts", () => {
  it("enforces operationMs with a retryable TimeoutError", async () => {
    sim.mockImplementation(() => new Promise(() => undefined));
    const v = new TestVault({ ...BASE, timeouts: { operationMs: 20 } });
    const e = await v.totalAssets().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TimeoutError);
    expect((e as Error).message).toBe("totalAssets timed out after 20ms");
    expect((e as TimeoutError).retryable).toBe(true);
  });
});

describe("retry policy", () => {
  const policy = { maxAttempts: 3, baseDelayMs: 1, jitter: false };

  it("does not retry by default", async () => {
    sim.mockRejectedValue(new Error("fetch failed"));
    await expect(new TestVault(BASE).totalAssets()).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(sim).toHaveBeenCalledTimes(1);
  });

  it("retries read-only calls when configured", async () => {
    sim
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(42n);
    await expect(
      new TestVault({ ...BASE, retry: policy }).totalAssets()
    ).resolves.toBe(42n);
    expect(sim).toHaveBeenCalledTimes(2);
  });

  it("does not retry transaction builders unless retryTxBuilders is set", async () => {
    prep.mockRejectedValue(new Error("fetch failed"));
    await expect(
      new TestVault({ ...BASE, retry: policy }).deposit(5n, WALLET)
    ).rejects.toBeInstanceOf(NetworkError);
    expect(prep).toHaveBeenCalledTimes(1);

    prep.mockReset();
    prep
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ xdr: "X", fee: "1" });
    await expect(
      new TestVault({
        ...BASE,
        retry: { ...policy, retryTxBuilders: true },
      }).deposit(5n, WALLET)
    ).resolves.toEqual({ xdr: "X", fee: "1" });
    expect(prep).toHaveBeenCalledTimes(2);
  });

  it("never retries non-retryable errors", async () => {
    sim.mockRejectedValue(new Error("Simulation failed: nope"));
    await expect(
      new TestVault({ ...BASE, retry: policy }).totalAssets()
    ).rejects.toThrow("Simulation failed: nope");
    expect(sim).toHaveBeenCalledTimes(1);
  });
});

describe("hooks", () => {
  it("fire start/success with sanitized params", async () => {
    sim.mockResolvedValue(7n);
    const onRequestStart = vi.fn();
    const onRequestSuccess = vi.fn();
    await new TestVault({
      ...BASE,
      hooks: { onRequestStart, onRequestSuccess },
    }).maxWithdraw(WALLET);
    expect(onRequestStart).toHaveBeenCalledTimes(1);
    expect(onRequestStart.mock.calls[0]![0]).toEqual({
      operation: "maxWithdraw",
      params: { owner: WALLET },
      attempt: 1,
    });
    expect(onRequestSuccess.mock.calls[0]![0]).toMatchObject({
      operation: "maxWithdraw",
      attempt: 1,
      durationMs: expect.any(Number),
    });
  });

  it("fire error and retry with scrubbed errors and no cause", async () => {
    const secret = "S" + "B".repeat(55);
    sim
      .mockRejectedValueOnce(
        new Error(`fetch failed https://rpc.x/KEY123 ${secret}`)
      )
      .mockResolvedValueOnce(1n);
    const onRequestError = vi.fn();
    const onRetry = vi.fn();
    await new TestVault({
      ...BASE,
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      hooks: { onRequestError, onRetry },
    }).totalAssets();
    for (const hook of [onRequestError, onRetry]) {
      const event = hook.mock.calls[0]![0];
      const text = JSON.stringify(event);
      expect(text).not.toMatch(/KEY123|SBBBB/);
      expect(event.error).toMatchObject({ code: "NETWORK", retryable: true });
      expect(event.error).not.toHaveProperty("cause");
    }
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, delayMs: 1 });
  });

  it("reports durationMs per attempt, excluding earlier attempts and backoff", async () => {
    vi.useFakeTimers();
    try {
      sim
        .mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 40));
          throw new Error("fetch failed");
        })
        .mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 1n;
        });
      const onRequestError = vi.fn();
      const onRequestSuccess = vi.fn();
      const p = new TestVault({
        ...BASE,
        retry: { maxAttempts: 2, baseDelayMs: 500, jitter: false },
        hooks: { onRequestError, onRequestSuccess },
      }).totalAssets();
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(onRequestError.mock.calls[0]![0]).toMatchObject({
        attempt: 1,
        durationMs: 40,
      });
      expect(onRequestSuccess.mock.calls[0]![0]).toMatchObject({
        attempt: 2,
        durationMs: 10,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("redact sensitive params", async () => {
    // Operation params never include secrets today, but the pipeline must
    // still scrub anything seed-shaped that a future method might pass.
    sim.mockResolvedValue(1n);
    const onRequestStart = vi.fn();
    const seed = "S" + "C".repeat(55);
    await new TestVault({ ...BASE, hooks: { onRequestStart } })
      .maxWithdraw(seed as never)
      .catch(() => undefined);
    expect(JSON.stringify(onRequestStart.mock.calls[0]![0])).not.toContain(
      seed
    );
    expect(JSON.stringify(onRequestStart.mock.calls[0]![0])).toContain(
      REDACTED
    );
  });

  it("never let a throwing hook change the result", async () => {
    sim.mockResolvedValue(9n);
    const boom = () => {
      throw new Error("hook bug");
    };
    await expect(
      new TestVault({
        ...BASE,
        hooks: {
          onRequestStart: boom,
          onRequestSuccess: async () => {
            throw new Error("async hook bug");
          },
        },
      }).totalAssets()
    ).resolves.toBe(9n);
  });

  it("emit one event set per public call, not per internal read", async () => {
    sim.mockResolvedValue(10n);
    const onRequestStart = vi.fn();
    await new TestVault({ ...BASE, hooks: { onRequestStart } }).maxMint(WALLET);
    expect(onRequestStart).toHaveBeenCalledTimes(1);
  });
});
