import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useVaults } from "../../hooks/useVaults";

vi.mock("../../lib/api", () => ({
  api: {
    getVaults: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const getVaults = vi.mocked(api.getVaults);

const VAULTS = [
  {
    id: "meridian-usdc",
    protocol: "meridian" as const,
    asset: "USDC",
    name: "Meridian USDC",
    label: "Meridian USDC Vault",
    apy: 7.25,
    tvl: 1_250_000,
    userBalance: 0,
    riskLevel: "safe" as const,
  },
  {
    id: "blend-usdc",
    protocol: "blend" as const,
    asset: "USDC",
    name: "Blend USDC",
    label: "Blend USDC Pool",
    apy: 5.1,
    tvl: 800_000,
    userBalance: 12,
    riskLevel: "safe" as const,
  },
];

function response(over: Partial<{ recommendedVaultId: string | null }> = {}) {
  return {
    vaults: VAULTS,
    recommendedVaultId: "meridian-usdc" as string | null,
    updatedAt: "2026-09-30T12:00:00.000Z",
    cached: false,
    ...over,
  };
}

function setup() {
  const client = new QueryClient({
    // The hook sets retry: 1; a zero delay keeps the error case fast.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, ...renderHook(() => useVaults(), { wrapper }) };
}

describe("useVaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is loading before the request resolves", () => {
    getVaults.mockReturnValue(new Promise(() => {}));
    const { result } = setup();

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(getVaults).toHaveBeenCalledTimes(1);
  });

  it("returns only the vaults and the recommended id, dropping transport metadata", async () => {
    getVaults.mockResolvedValue(response());
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ vaults: VAULTS, recommendedVaultId: "meridian-usdc" });
    expect(result.current.data).not.toHaveProperty("updatedAt");
    expect(result.current.data).not.toHaveProperty("cached");
    expect(result.current.error).toBeNull();
  });

  it("passes through a null recommendation when nothing is routable", async () => {
    getVaults.mockResolvedValue(response({ recommendedVaultId: null }));
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.recommendedVaultId).toBeNull();
    expect(result.current.data?.vaults).toHaveLength(2);
  });

  it("surfaces the error once the single retry is exhausted", async () => {
    getVaults.mockRejectedValue(new Error("vaults unavailable"));
    const { result } = setup();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("vaults unavailable");
    expect(result.current.data).toBeUndefined();
    // retry: 1 means the original call plus exactly one retry.
    expect(getVaults).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    getVaults.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(response());
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.vaults).toEqual(VAULTS);
    expect(getVaults).toHaveBeenCalledTimes(2);
  });

  it("caches under the vaults query key with a 5 minute stale time", async () => {
    getVaults.mockResolvedValue(response());
    const { result, client } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(["vaults"])).toEqual({ vaults: VAULTS, recommendedVaultId: "meridian-usdc" });
    const query = client.getQueryCache().find({ queryKey: ["vaults"] });
    expect(query?.isStale()).toBe(false);
    expect(query?.observers[0]?.options.staleTime).toBe(5 * 60_000);
  });
});
