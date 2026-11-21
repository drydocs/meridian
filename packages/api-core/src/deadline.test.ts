import { describe, expect, it, vi } from "vitest";
import { UpstreamDeadlineError } from "@meridian/shared";
import { deadlineResult, withUpstreamDeadline } from "./deadline";

describe("upstream deadlines", () => {
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
});
