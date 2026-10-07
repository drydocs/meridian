import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAdminHistory, type AdminAction } from "../../hooks/useAdminHistory";

vi.mock("../../lib/api", () => ({
  api: {
    getAdminHistory: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const getAdminHistory = vi.mocked(api.getAdminHistory);

const ACTION: AdminAction = {
  id: "a1",
  type: "rebalance",
  timestamp: "2026-01-01T00:00:00Z",
  transactionHash: "abc123",
  sourceAccount: "GADMIN",
  summary: "Rebalanced vault",
  details: { from: "blend", to: "defindex" },
};

type AdminHistory = Awaited<ReturnType<typeof api.getAdminHistory>>;

const RESPONSE: AdminHistory = {
  vaultId: "vault-1",
  contractId: "CABCDEF",
  actions: [ACTION],
  updatedAt: "2026-01-01T00:00:00Z",
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  getAdminHistory.mockReset();
});

describe("useAdminHistory", () => {
  it("requests history for the vault and returns the data on success", async () => {
    getAdminHistory.mockResolvedValue(RESPONSE);
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAdminHistory("vault-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAdminHistory).toHaveBeenCalledOnce();
    expect(getAdminHistory).toHaveBeenCalledWith("vault-1");
    expect(result.current.data).toEqual(RESPONSE);
  });

  it("is loading while the request is in flight", async () => {
    let resolve!: (v: AdminHistory) => void;
    getAdminHistory.mockReturnValue(
      new Promise<AdminHistory>((r) => {
        resolve = r;
      })
    );
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAdminHistory("vault-1"), {
      wrapper,
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();

    resolve(RESPONSE);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it("surfaces an error after the single retry is exhausted", async () => {
    getAdminHistory.mockRejectedValue(new Error("boom"));
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAdminHistory("vault-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe("boom");
    expect(result.current.data).toBeUndefined();
    // retry: 1 => initial attempt + one retry
    expect(getAdminHistory).toHaveBeenCalledTimes(2);
  });

  it("does not fetch when there is no vault id", () => {
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useAdminHistory(null), { wrapper });

    expect(getAdminHistory).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  it("keys the cache per vault so different vaults do not share data", async () => {
    getAdminHistory.mockImplementation(async (id: string) => ({
      ...RESPONSE,
      vaultId: id,
      actions: [{ ...ACTION, id }],
    }));
    const { client, wrapper } = makeWrapper();

    const first = renderHook(() => useAdminHistory("vault-1"), { wrapper });
    const second = renderHook(() => useAdminHistory("vault-2"), { wrapper });

    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(first.result.current.data?.actions).toEqual([
      { ...ACTION, id: "vault-1" },
    ]);
    expect(second.result.current.data?.actions).toEqual([
      { ...ACTION, id: "vault-2" },
    ]);
    expect(client.getQueryData(["adminHistory", "vault-1"])).toBeDefined();
    expect(client.getQueryData(["adminHistory", "vault-2"])).toBeDefined();
  });
});
