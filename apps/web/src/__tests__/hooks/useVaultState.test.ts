import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useVaultState } from "../../hooks/useVaultState";

vi.mock("../../lib/api", () => ({
  api: {
    getVaultState: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const getVaultState = vi.mocked(api.getVaultState);

const STATE = {
  protocol: "meridian",
  adapterId: "blend-usdc",
  totalShares: 1_000_000,
  totalAssets: 1_025_000,
  paused: false,
};

function setup() {
  const client = new QueryClient({
    // The hook sets retry: 1; a zero delay keeps the error case fast.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, ...renderHook(() => useVaultState(), { wrapper }) };
}

describe("useVaultState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is loading before the request resolves", () => {
    getVaultState.mockReturnValue(new Promise(() => {}));
    const { result } = setup();

    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(getVaultState).toHaveBeenCalledTimes(1);
  });

  it("returns the vault state on success", async () => {
    getVaultState.mockResolvedValue(STATE);
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(STATE);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getVaultState).toHaveBeenCalledTimes(1);
  });

  it("reports a paused vault as returned, without transforming it", async () => {
    getVaultState.mockResolvedValue({ ...STATE, paused: true });
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.paused).toBe(true);
  });

  it("surfaces the error once the single retry is exhausted", async () => {
    getVaultState.mockRejectedValue(new Error("vault state unavailable"));
    const { result } = setup();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("vault state unavailable");
    expect(result.current.data).toBeUndefined();
    // retry: 1 means the original call plus exactly one retry.
    expect(getVaultState).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    getVaultState.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(STATE);
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(STATE);
    expect(getVaultState).toHaveBeenCalledTimes(2);
  });

  it("caches under the vault-state query key with a 30s stale time", async () => {
    getVaultState.mockResolvedValue(STATE);
    const { result, client } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(["vault-state"])).toEqual(STATE);
    const query = client.getQueryCache().find({ queryKey: ["vault-state"] });
    expect(query?.isStale()).toBe(false);
    expect(query?.observers[0]?.options.staleTime).toBe(30_000);
  });
});
