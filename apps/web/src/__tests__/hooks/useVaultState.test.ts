import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  computeMinSharesOut,
  computeMinUsdcOut,
  useVaultState,
} from "../../hooks/useVaultState";
import { usePublicVaultState } from "../../hooks/usePublicVaultState";

vi.mock("../../lib/api", () => ({
  api: {
    getVaultState: vi.fn(),
    getPublicVaultState: vi.fn(),
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

describe("computeMinSharesOut / computeMinUsdcOut", () => {
  it("applies the default 50 bps haircut to deposit shares", () => {
    // amount 25, share price 2.0 (100 assets / 50 shares) -> 12.5 * 0.995
    expect(computeMinSharesOut(25, 100, 50)).toBe("12.4375000");
  });

  it("charges no fee while the payout is at or below the cost basis", () => {
    // 10 shares at 2.0 = 20, all of it basis, so only the haircut applies.
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 50,
        principal: 20,
        positionShares: 10,
      })
    ).toBe("19.9000000");
  });

  it("prices the floor net of the 10% fee on the gain", () => {
    // 20 gross, 34 * 10/20 = 17 of it basis, 3 gain, 0.3 fee -> 19.7 * 0.995
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 50,
        principal: 34,
        positionShares: 20,
      })
    ).toBe("19.6015000");
  });

  it("treats an unknown cost basis as entirely gain", () => {
    // 20 gross, no basis to offset it, 2 fee -> 18 * 0.995
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 50,
        principal: 0,
        positionShares: 0,
      })
    ).toBe("17.9100000");
  });

  it("returns undefined when the vault has no shares yet", () => {
    expect(computeMinSharesOut(10, 0, 0)).toBeUndefined();
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 0,
        principal: 0,
        positionShares: 0,
      })
    ).toBeUndefined();
  });
});

describe("useVaultState", () => {
  beforeEach(() => {
    window.sessionStorage.setItem("meridian-admin-session", "signed-session");
    vi.clearAllMocks();
  });

  it("is loading before the request resolves", () => {
    getVaultState.mockReturnValue(new Promise(() => {}));
    const { result } = setup();

    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(getVaultState).toHaveBeenCalledWith("signed-session");
  });

  it("returns the vault state on success", async () => {
    getVaultState.mockResolvedValue(STATE);
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(STATE);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getVaultState).toHaveBeenCalledWith("signed-session");
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
    getVaultState
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(STATE);
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(STATE);
    expect(getVaultState).toHaveBeenCalledTimes(2);
  });

  it("caches under the vault-state query key with a 30s stale time", async () => {
    getVaultState.mockResolvedValue(STATE);
    const { result, client } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(["vault-state", "admin", true])).toEqual(STATE);
    const query = client.getQueryCache().find({ queryKey: ["vault-state", "admin"] });
    expect(query?.isStale()).toBe(false);
    expect(query?.observers[0]?.options.staleTime).toBe(30_000);
  });

  it("does not fetch admin state without a signed session", () => {
    window.sessionStorage.clear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useVaultState(), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(getVaultState).not.toHaveBeenCalled();
  });

  it("fetches public vault state without a wallet or session", async () => {
    window.sessionStorage.clear();
    const getPublicVaultState = vi.mocked(api.getPublicVaultState);
    getPublicVaultState.mockResolvedValue(STATE);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => usePublicVaultState(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getPublicVaultState).toHaveBeenCalledOnce();
  });
});
