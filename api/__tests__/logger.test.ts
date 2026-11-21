import { describe, expect, it, vi } from "vitest";
import { log, logError, redact, requestId, writeLog } from "../_lib/logger.js";

function parseLog(
  output: ReturnType<typeof vi.spyOn>
): Record<string, unknown> {
  const line = output.mock.calls[0]?.[0];
  if (typeof line !== "string") throw new Error("logger did not write a line");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("structured logger", () => {
  it("redacts secret-like values recursively and shortens wallet addresses", () => {
    expect(
      redact({
        bearerToken: "secret",
        signedXdr: "signed payload",
        xdr: "unsigned payload",
        publicKey: "GABC1234567890",
      })
    ).toEqual({
      bearerToken: "[REDACTED]",
      signedXdr: "[REDACTED]",
      xdr: "[REDACTED]",
      publicKey: "GABC12…7890",
    });
  });

  it("emits JSON with level, event, and request correlation", () => {
    const output = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    log(
      "info",
      "vault.read",
      { headers: { "x-request-id": "req-123" } },
      { route: "/api/v1/vaults" }
    );
    expect(output).toHaveBeenCalledTimes(1);
    expect(parseLog(output)).toMatchObject({
      level: "info",
      event: "vault.read",
      requestId: "req-123",
      route: "/api/v1/vaults",
    });
    output.mockRestore();
  });

  it("keeps unexpected errors as stack-bearing structured fields", () => {
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    writeLog("error", "handler.failed", {
      error: { message: "boom", stack: "stack" },
    });
    expect(parseLog(output).error).toEqual({
      message: "boom",
      stack: "stack",
    });
    output.mockRestore();
  });

  it("replaces malformed or oversized inbound request IDs", () => {
    expect(requestId({ headers: { "x-request-id": "safe-id_123" } })).toBe(
      "safe-id_123"
    );
    expect(requestId({ headers: { "x-request-id": "invalid id" } })).not.toBe(
      "invalid id"
    );
    expect(
      requestId({ headers: { "x-request-id": "x".repeat(129) } })
    ).not.toBe("x".repeat(129));
  });

  it("redacts error messages, stacks, and causes before logging", () => {
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const cause = new Error("RPC failed at https://rpc.example/?token=secret");
    const error = new Error(
      "submit failed at https://rpc.example/?token=secret"
    ) as Error & { cause?: unknown };
    error.cause = cause;
    error.stack =
      "Error: submit failed\n    at https://rpc.example/?token=secret";

    logError("submit.failed", undefined, error);

    const detail = parseLog(output).error as {
      message: string;
      stack: string;
      cause: { message: string };
    };
    expect(detail.message).toBe("Unexpected error");
    expect(detail.stack).toBe("Error: submit failed");
    expect(detail.cause.message).toBe("Unexpected error");
    expect(JSON.stringify(detail)).not.toContain("https://");
    output.mockRestore();
  });
});
