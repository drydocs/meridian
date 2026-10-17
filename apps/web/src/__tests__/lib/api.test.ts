import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  clearAdminSession,
  configureAdminSessionQueryClient,
  getAdminSessionToken,
} from "../../lib/adminSession";

function response(status: number, body: unknown = { error: "failed" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  configureAdminSessionQueryClient(new QueryClient());
});

describe("admin API session invalidation", () => {
  it.each([401, 403])("clears the session on an authenticated %s", async (status) => {
    window.sessionStorage.setItem("meridian-admin-session", "token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));

    await expect(api.getVaultState("token")).rejects.toThrow(
      "Session ended, please sign in again"
    );
    expect(getAdminSessionToken()).toBeNull();
  });

  it("does not clear the session on a 500 or network error", async () => {
    window.sessionStorage.setItem("meridian-admin-session", "token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(500))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getVaultState("token")).rejects.toThrow("failed");
    expect(getAdminSessionToken()).toBe("token");
    await expect(api.getVaultState("token")).rejects.toThrow("network down");
    expect(getAdminSessionToken()).toBe("token");
  });

  it("does not clear the session for a public endpoint failure", async () => {
    window.sessionStorage.setItem("meridian-admin-session", "token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));

    await expect(api.getPublicVaultState()).rejects.toThrow("failed");
    expect(getAdminSessionToken()).toBe("token");
  });

  it("clears storage and admin query caches on logout", () => {
    const queryClient = new QueryClient();
    configureAdminSessionQueryClient(queryClient);
    queryClient.setQueryData(["adminHistory", "vault"], { actions: [1] });
    queryClient.setQueryData(["vault-state", "admin", true], { paused: false });
    queryClient.setQueryData(["vault-state", "public"], { paused: false });
    window.sessionStorage.setItem("meridian-admin-session", "token");

    clearAdminSession();

    expect(getAdminSessionToken()).toBeNull();
    expect(queryClient.getQueryData(["adminHistory", "vault"])).toBeUndefined();
    expect(queryClient.getQueryData(["vault-state", "admin", true])).toBeUndefined();
    expect(queryClient.getQueryData(["vault-state", "public"])).toEqual({ paused: false });
  });
});
