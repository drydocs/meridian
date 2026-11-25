import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError } from "../../lib/api";
import { reportError } from "../../lib/errorReporter";

vi.mock("../../lib/errorReporter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/errorReporter")>();
  return { ...actual, reportError: vi.fn() };
});

describe("API error reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports HTTP failures with method, scrubbed path, status, and category", async () => {
    const walletAddress = `G${"A".repeat(55)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "service unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(api.getPositions(walletAddress)).rejects.toBeInstanceOf(
      ApiRequestError
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.any(ApiRequestError),
      expect.objectContaining({
        category: "api",
        api: {
          method: "GET",
          path: "/api/v1/positions/[REDACTED]",
          status: 503,
          category: "http_server_error",
        },
      })
    );
  });

  it("reports request timeouts with a null status and timeout category", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutError));

    await expect(api.getVaults()).rejects.toMatchObject({
      context: {
        method: "GET",
        path: "/api/v1/vaults",
        status: null,
        category: "timeout",
      },
    });
  });

  it("requests state for the specified vault", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocol: "blend",
          adapterId: "adapter",
          totalShares: 10,
          totalAssets: 10,
          paused: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getVaultState("meridian-eurc");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/vault-state?vaultId=meridian-eurc",
      expect.any(Object)
    );
  });

  it("reports non-GET methods and client HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(api.addTrustline("wallet")).rejects.toBeInstanceOf(
      ApiRequestError
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.any(ApiRequestError),
      expect.objectContaining({
        api: {
          method: "POST",
          path: "/api/v1/tx/add-trustline",
          status: 400,
          category: "http_client_error",
        },
      })
    );
  });
});
