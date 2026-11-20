import { describe, expect, it, vi } from "vitest";
import { log, redact, writeLog } from "../_lib/logger.js";

describe("structured logger", () => {
  it("redacts secret-like values recursively and shortens wallet addresses", () => {
    expect(
      redact({
        bearerToken: "secret",
        signedXdr: "xdr",
        publicKey: "GABC1234567890",
      })
    ).toEqual({
      bearerToken: "[REDACTED]",
      signedXdr: "[REDACTED]",
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
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({
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
    expect(JSON.parse(output.mock.calls[0][0] as string).error).toEqual({
      message: "boom",
      stack: "stack",
    });
    output.mockRestore();
  });
});
