import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import {
  initializeErrorReporter,
  reportError,
  scrubSensitiveData,
} from "../../lib/errorReporter";

vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

const walletAddress = `G${"A".repeat(55)}`;

describe("error reporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/app/");
  });

  it("does nothing until a Sentry DSN is configured", () => {
    reportError(new Error("local error"), { category: "test" });

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("scrubs wallet addresses, XDR, and secret fields", () => {
    const report = {
      message: `wallet=${walletAddress} encoded=${encodeURIComponent(walletAddress)} xdr=AAAA${"A".repeat(100)}`,
      request: {
        walletAddress,
        xdr: "raw transaction envelope",
        token: "secret-token",
        client_secret: "another-secret",
        secretKey: "stellar-secret",
      },
    };

    expect(scrubSensitiveData(report)).toEqual({
      message: "wallet=[REDACTED] encoded=[REDACTED] xdr=[REDACTED]",
      request: {
        walletAddress: "[REDACTED]",
        xdr: "[REDACTED]",
        token: "[REDACTED]",
        client_secret: "[REDACTED]",
        secretKey: "[REDACTED]",
      },
    });
  });

  it("reports global failures with route, version, network, and scrubbed event data", () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    vi.stubEnv("VITE_APP_VERSION", "web@0.1.0");
    window.history.replaceState({}, "", `/app/${walletAddress}`);

    initializeErrorReporter();
    reportError(new Error(`failure for ${walletAddress}`), {
      category: "render",
    });
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "uncaught",
        error: new Error("uncaught"),
      })
    );
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", {
      value: new Error("unhandled"),
    });
    window.dispatchEvent(rejection);

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@example.ingest.sentry.io/1",
        release: "web@0.1.0",
        defaultIntegrations: false,
      })
    );
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: `failure for ${walletAddress}` }),
      expect.objectContaining({
        tags: expect.objectContaining({
          category: "render",
          route: "/app/[REDACTED]",
          app_version: "web@0.1.0",
          network: expect.any(String),
        }),
      })
    );

    const initOptions = vi.mocked(Sentry.init).mock.calls[0][0];
    const event = {
      message: `wallet ${walletAddress}`,
      extra: { xdr: "raw transaction envelope" },
    };
    expect(initOptions?.beforeSend?.(event as never, {} as never)).toEqual({
      message: "wallet [REDACTED]",
      extra: { xdr: "[REDACTED]" },
    });
  });
});
