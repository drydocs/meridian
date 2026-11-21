import { describe, expect, it, vi } from "vitest";
import { UpstreamDeadlineError } from "@meridian/shared";
import {
  deadlineResult,
  resolveUpstreamTimeout,
  withUpstreamDeadline,
} from "./deadline";

const timeoutCases: Array<[string | undefined, number]> = [
  [undefined, 8_000],
  ["not-a-number", 8_000],
  ["99", 8_000],
  ["100", 100],
  ["30000", 30_000],
  ["30001", 8_000],
];

describe("upstream deadlines", () => {
  it.each(timeoutCases)(
    "resolves RPC_TIMEOUT_MS %s to %i",
    (value, expected) => {
      expect(resolveUpstreamTimeout(value)).toBe(expected);
    }
  );

  it("returns a fast upstream result", async () => {
    await expect(withUpstreamDeadline(async () => "ok", "rpc")).resolves.toBe(
      "ok"
    );
  });

  it("returns a typed deadline with a retry hint", async () => {
    vi.useFakeTimers();
    const pending = withUpstreamDeadline(
      () => new Promise<string>(() => {}),
      "rpc"
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(
      UpstreamDeadlineError
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
    const result = deadlineResult(
      new UpstreamDeadlineError("rpc", 8_000),
      "fallback"
    );
    expect(result).toMatchObject({
      status: 503,
      body: {
        code: "UPSTREAM_DEADLINE_EXCEEDED",
        retryAfterSeconds: 1,
      },
    });
    vi.useRealTimers();
  });

  it("normalizes native timeout and ordinary errors", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(deadlineResult(timeout, "fallback")).toMatchObject({
      status: 503,
      body: { retryAfterSeconds: 1 },
    });
    expect(deadlineResult("failed", "fallback", 429)).toMatchObject({
      status: 429,
      body: { error: "fallback" },
    });
  });
});
