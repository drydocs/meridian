import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useKeeperHealth } from "../../hooks/useKeeperHealth";

vi.mock("../../lib/api", () => ({
  api: {
    getKeeperHealth: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const getKeeperHealth = vi.mocked(api.getKeeperHealth);

const HEALTH = {
  keepers: [
    {
      id: "accrual" as const,
      intervalMs: 60_000,
      lastSuccessMs: 1_700_000_000_000,
      healthy: true,
    },
    {
      id: "migration" as const,
      intervalMs: 300_000,
      lastSuccessMs: null,
      healthy: false,
    },
  ],
  checkedAt: "2026-09-30T12:00:00.000Z",
};

function setup() {
  const client = new QueryClient({
    // The hook sets retry: 1; the client-level default does not override an
    // option the hook passes itself, so error tests wait out one retry.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, ...renderHook(() => useKeeperHealth(), { wrapper }) };
}

describe("useKeeperHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is loading before the request resolves", async () => {
    getKeeperHealth.mockReturnValue(new Promise(() => {}));
    const { result } = setup();

    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(getKeeperHealth).toHaveBeenCalledTimes(1);
  });

  it("returns the keeper health payload on success", async () => {
    getKeeperHealth.mockResolvedValue(HEALTH);
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(HEALTH);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getKeeperHealth).toHaveBeenCalledTimes(1);
  });

  it("surfaces the error once the single retry is exhausted", async () => {
    getKeeperHealth.mockRejectedValue(new Error("keepers unavailable"));
    const { result } = setup();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("keepers unavailable");
    expect(result.current.data).toBeUndefined();
    // retry: 1 means the original call plus exactly one retry.
    expect(getKeeperHealth).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    getKeeperHealth
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(HEALTH);
    const { result } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(HEALTH);
    expect(getKeeperHealth).toHaveBeenCalledTimes(2);
  });

  it("caches under the keeper-health query key with a 30s stale time", async () => {
    getKeeperHealth.mockResolvedValue(HEALTH);
    const { result, client } = setup();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(["keeper-health"])).toEqual(HEALTH);
    const query = client.getQueryCache().find({ queryKey: ["keeper-health"] });
    expect(query).toBeDefined();
    expect(query?.isStale()).toBe(false);
    expect(query?.observers[0]?.options.staleTime).toBe(30_000);
  });
});
