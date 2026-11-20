import { describe, expect, it, vi } from "vitest";
import { NetworkError, ValidationError } from "./errors.js";
import { retryDelayMs, withRetry } from "./retry.js";

const noSleep = { sleep: async () => undefined };

describe("retryDelayMs", () => {
  it("doubles from the base and caps at maxDelayMs", () => {
    const p = {
      maxAttempts: 9,
      baseDelayMs: 100,
      maxDelayMs: 500,
      jitter: false,
    };
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(p, n))).toEqual([
      100, 200, 400, 500, 500,
    ]);
  });

  it("adds bounded jitter", () => {
    const p = { maxAttempts: 3, baseDelayMs: 100 };
    expect(retryDelayMs(p, 1, () => 1)).toBe(125);
    expect(retryDelayMs(p, 1, () => 0)).toBe(100);
  });
});

describe("withRetry", () => {
  it("does not retry without a policy", async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError("down"));
    await expect(withRetry(fn, undefined, noSleep)).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors until success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("a"))
      .mockRejectedValueOnce(new NetworkError("b"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    const out = await withRetry(
      fn,
      { maxAttempts: 3, jitter: false },
      { ...noSleep, onRetry }
    );
    expect(out).toBe("ok");
    expect(fn.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({
      attempt: 1,
      delayMs: 200,
    });
  });

  it("stops at maxAttempts and throws the last classified error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(
      withRetry(fn, { maxAttempts: 2 }, noSleep)
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never retries non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new ValidationError("no"));
    await expect(
      withRetry(fn, { maxAttempts: 5 }, noSleep)
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours a custom shouldRetry", async () => {
    const fn = vi.fn().mockRejectedValue(new ValidationError("no"));
    await expect(
      withRetry(fn, { maxAttempts: 3, shouldRetry: () => true }, noSleep)
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
