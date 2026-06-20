import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "./utils";

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves immediately when fn succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and resolves when fn fails then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, 3, 0);
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws last error after exhausting all attempts", async () => {
    const err = new Error("persistent");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, 3, 0);
    const assertion = expect(promise).rejects.toThrow("persistent");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects maxAttempts=1 by not retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const promise = withRetry(fn, 1, 0);
    const assertion = expect(promise).rejects.toThrow("fail");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
