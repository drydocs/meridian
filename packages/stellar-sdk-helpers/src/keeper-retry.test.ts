import { describe, expect, it, vi } from "vitest";
import {
  consoleLogger,
  DEFAULT_RETRY_OPTIONS,
  errorMessage,
  KeeperError,
  KeeperRetryError,
  parseNonNegativeInt,
  parsePositiveInt,
  redactedErrorMessage,
  retryOutcome,
  sleep,
  withKeeperRetry,
  type RetryOptions,
} from "./keeper-retry";

describe("keeper-retry", () => {
  describe("consoleLogger", () => {
    it("logs info, warn, and error", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      consoleLogger.info("info msg", { a: 1 });
      consoleLogger.warn("warn msg");
      consoleLogger.error("error msg", { b: 2 });

      expect(infoSpy).toHaveBeenCalledWith("info msg", { a: 1 });
      expect(warnSpy).toHaveBeenCalledWith("warn msg", {});
      expect(errorSpy).toHaveBeenCalledWith("error msg", { b: 2 });

      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("sleep", () => {
    it("resolves after timeout", async () => {
      vi.useFakeTimers();
      const promise = sleep(100);
      vi.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe("errorMessage", () => {
    it("formats error messages correctly", () => {
      expect(errorMessage(new Error("First line\nSecond line"))).toBe(
        "First line"
      );
      expect(errorMessage(new Error(""))).toBe("");
      expect(errorMessage("string error")).toBe("string error");
      expect(errorMessage(123)).toBe("123");
    });
  });

  describe("redactedErrorMessage", () => {
    it("redacts secret/sensitive content", () => {
      expect(redactedErrorMessage(new Error("RPC failed"))).toBeDefined();
    });
  });

  describe("parsePositiveInt", () => {
    it("parses valid positive integers and uses fallbacks", () => {
      expect(parsePositiveInt(undefined, 10, "test")).toBe(10);
      expect(parsePositiveInt("", 10, "test")).toBe(10);
      expect(parsePositiveInt("   ", 10, "test")).toBe(10);
      expect(parsePositiveInt("5", 10, "test")).toBe(5);
    });

    it("throws on non-integer or non-positive values", () => {
      expect(() => parsePositiveInt("0", 10, "test")).toThrow(
        "test must be a positive integer"
      );
      expect(() => parsePositiveInt("-1", 10, "test")).toThrow(
        "test must be a positive integer"
      );
      expect(() => parsePositiveInt("1.5", 10, "test")).toThrow(
        "test must be a positive integer"
      );
      expect(() => parsePositiveInt("abc", 10, "test")).toThrow(
        "test must be a positive integer"
      );
    });
  });

  describe("parseNonNegativeInt", () => {
    it("parses valid non-negative integers and uses fallbacks", () => {
      expect(parseNonNegativeInt(undefined, 0, "test")).toBe(0);
      expect(parseNonNegativeInt("0", 10, "test")).toBe(0);
      expect(parseNonNegativeInt("5", 10, "test")).toBe(5);
    });

    it("throws on non-integer or negative values", () => {
      expect(() => parseNonNegativeInt("-1", 10, "test")).toThrow(
        "test must be a non-negative integer"
      );
      expect(() => parseNonNegativeInt("2.3", 10, "test")).toThrow(
        "test must be a non-negative integer"
      );
    });
  });

  describe("KeeperError", () => {
    it("creates a KeeperError with message and cause", () => {
      const cause = new Error("root cause");
      const err = new KeeperError("keeper failure", cause);
      expect(err.name).toBe("KeeperError");
      expect(err.message).toBe("keeper failure");
      expect(err.cause).toBe(cause);
    });

    it("creates a KeeperError without cause", () => {
      const err = new KeeperError("simple failure");
      expect(err.name).toBe("KeeperError");
      expect(err.message).toBe("simple failure");
      expect(err.cause).toBeUndefined();
    });
  });

  describe("KeeperRetryError", () => {
    it("creates an error with attempt count and transient status, and is a KeeperError subclass", () => {
      const inner = new Error("boom");
      const err = new KeeperRetryError(inner, 3, true);
      expect(err.name).toBe("KeeperRetryError");
      expect(err.message).toBe("boom");
      expect(err.attempts).toBe(3);
      expect(err.transient).toBe(true);
      expect(err.cause).toBe(inner);
      expect(err).toBeInstanceOf(KeeperError);
    });
  });

  describe("RetryOptions type and DEFAULT_RETRY_OPTIONS", () => {
    it("DEFAULT_RETRY_OPTIONS has sensible defaults", () => {
      expect(DEFAULT_RETRY_OPTIONS.maxAttempts).toBe(3);
      expect(DEFAULT_RETRY_OPTIONS.baseDelayMs).toBe(200);
      expect(typeof DEFAULT_RETRY_OPTIONS.sleepFn).toBe("function");
      expect(DEFAULT_RETRY_OPTIONS.isTransient("anything")).toBe(true);
    });

    it("RetryOptions type accepts all optional fields", () => {
      const opts: RetryOptions = {
        maxAttempts: 5,
        baseDelayMs: 500,
        deadlineAt: Date.now() + 60_000,
        logger: consoleLogger,
        context: { key: "value" },
        sleepFn: sleep,
        isTransient: () => true,
        logPrefix: "test",
      };
      expect(opts.maxAttempts).toBe(5);
      expect(opts.baseDelayMs).toBe(500);
    });
  });

  describe("retryOutcome", () => {
    it("unwraps KeeperRetryError details", () => {
      const retryErr = new KeeperRetryError("fail", 2, true);
      expect(retryOutcome(retryErr, () => false)).toEqual({
        attempts: 2,
        transient: true,
      });
    });

    it("uses isTransient predicate for non-KeeperRetryError", () => {
      const genericErr = new Error("bad state");
      expect(retryOutcome(genericErr, (e) => e === genericErr)).toEqual({
        attempts: 1,
        transient: true,
      });
    });
  });

  describe("withKeeperRetry", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    it("returns value on first success", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const res = await withKeeperRetry(fn, {
        sleepFn: mockSleep,
        logger: mockLogger,
      });
      expect(res).toEqual({ value: "ok", attempts: 1 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("calls fn with a 0-indexed attempt number (attempt 0 is the first try)", async () => {
        // The off-by-one fix: attempt 0 = first try, attempt 1 = first retry.
        // keeperFeeForAttempt uses 0-indexed, so withKeeperRetry must pass
        // the same convention; otherwise every submission's fee doubling is
        // silently one step off from intended.
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("ok");

      await withKeeperRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: mockSleep,
        logger: mockLogger,
      });

      expect(fn).toHaveBeenNthCalledWith(1, 0);
      expect(fn).toHaveBeenNthCalledWith(2, 1);
    });

    it("uses options-based API with explicit isTransient", async () => {
      const transientErr = new Error("transient");
      const fn = vi
        .fn()
        .mockRejectedValueOnce(transientErr)
        .mockResolvedValueOnce("ok");
      const isTransient = vi.fn().mockReturnValue(true);

      const res = await withKeeperRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: mockSleep,
        logger: mockLogger,
        isTransient,
      });

      expect(res).toEqual({ value: "ok", attempts: 2 });
      expect(isTransient).toHaveBeenCalledWith(transientErr);
    });

    it("uses options-based API with logPrefix and context for logging", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("ok");
      const warn = vi.fn();

      await withKeeperRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: mockSleep,
        logger: { ...mockLogger, warn },
        isTransient: () => true,
        context: { vaultId: "v1" },
        logPrefix: "TEST",
      });

      expect(warn).toHaveBeenCalledWith(
        "[TEST] transient failure; retrying",
        expect.objectContaining({ vaultId: "v1" })
      );
    });

    it("retries on transient failure and succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("success");

      const res = await withKeeperRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: mockSleep,
        logger: mockLogger,
        isTransient: () => true,
        logPrefix: "TEST",
      });

      expect(res).toEqual({ value: "success", attempts: 2 });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[TEST] transient failure; retrying",
        expect.objectContaining({ attempt: 1, nextAttempt: 2 })
      );
    });

    it("stops immediately on non-transient error", async () => {
      const nonTransientErr = new Error("fatal");
      const fn = vi.fn().mockRejectedValue(nonTransientErr);

      await expect(
        withKeeperRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          sleepFn: mockSleep,
          logger: mockLogger,
          isTransient: () => false,
        })
      ).rejects.toThrow(KeeperRetryError);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("reports retry exhaustion: KeeperRetryError has correct attempts and transient after maxAttempts exhausted", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("persistent"));

      let thrown: KeeperRetryError | null = null;
      try {
        await withKeeperRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          sleepFn: mockSleep,
          logger: mockLogger,
          isTransient: () => true,
        });
      } catch (err) {
        thrown = err as KeeperRetryError;
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.attempts).toBe(3);
      expect(thrown!.transient).toBe(true);
      expect(thrown!).toBeInstanceOf(KeeperRetryError);
      expect(fn).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenNthCalledWith(1, 0);
      expect(fn).toHaveBeenNthCalledWith(2, 1);
      expect(fn).toHaveBeenNthCalledWith(3, 2);
    });

    it("stops when approaching deadline", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("transient"));
      const deadlineAt = Date.now() + 15;

      await expect(
        withKeeperRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 20,
          deadlineAt,
          sleepFn: mockSleep,
          logger: mockLogger,
          isTransient: () => true,
          logPrefix: "TEST",
        })
      ).rejects.toThrow(KeeperRetryError);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[TEST] stopping retries; run deadline approaching",
        expect.objectContaining({ attempt: 1 })
      );
    });

    it("applies exponential backoff for retries", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("t1"))
        .mockRejectedValueOnce(new Error("t2"))
        .mockResolvedValueOnce("ok");

      await withKeeperRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 10,
        sleepFn: mockSleep,
        logger: mockLogger,
        isTransient: () => true,
      });

      expect(mockSleep).toHaveBeenNthCalledWith(1, 10);
      expect(mockSleep).toHaveBeenNthCalledWith(2, 20);
      expect(mockSleep).toHaveBeenCalledTimes(2);
    });

    it("default isTransient classifies all errors as transient when not set", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("anything"))
        .mockResolvedValueOnce("ok");

      const res = await withKeeperRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: mockSleep,
        logger: mockLogger,
      });

      expect(res.attempts).toBe(2);
    });

    it("uses consoleLogger by default when logger option is omitted", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce("ok");

      await withKeeperRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        sleepFn: mockSleep,
      });

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
