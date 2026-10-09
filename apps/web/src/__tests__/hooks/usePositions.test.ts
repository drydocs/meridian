import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { usePositions } from "../../hooks/usePositions";

vi.mock("../../lib/api", () => ({
  api: {
    getPositions: vi.fn(),
  },
}));

import { api } from "../../lib/api";

const getPositions = vi.mocked(api.getPositions);

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_KEY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const POSITIONS = [
  {
    vaultId: "meridian-usdc",
    shares: 100,
    deposited: 100,
    earned: 1.5,
    entryTime: 1_700_000_000,
  },
  {
    vaultId: "blend-usdc",
    shares: 40,
    deposited: 42,
    earned: 0.25,
    entryTime: 1_700_100_000,
  },
];

function setup(publicKey: string | null) {
  const client = new QueryClient({
    // The hook sets retry: 1; a zero delay keeps the error case fast.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const utils = renderHook(
    ({ key }: { key: string | null }) => usePositions(key),
    {
      wrapper,
      initialProps: { key: publicKey },
    }
  );
  return { client, ...utils };
}

describe("usePositions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is loading before the request resolves", () => {
    getPositions.mockReturnValue(new Promise(() => {}));
    const { result } = setup(KEY);

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(getPositions).toHaveBeenCalledWith(KEY);
  });

  it("returns the positions array (unwrapped from the response) on success", async () => {
    getPositions.mockResolvedValue({ positions: POSITIONS });
    const { result } = setup(KEY);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(POSITIONS);
    expect(result.current.error).toBeNull();
    expect(getPositions).toHaveBeenCalledTimes(1);
    expect(getPositions).toHaveBeenCalledWith(KEY);
  });

  it("returns an empty array when the wallet has no positions", async () => {
    getPositions.mockResolvedValue({ positions: [] });
    const { result } = setup(KEY);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it("does not fetch while no wallet is connected", () => {
    const { result } = setup(null);

    expect(getPositions).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("surfaces the error once the single retry is exhausted", async () => {
    getPositions.mockRejectedValue(new Error("positions unavailable"));
    const { result } = setup(KEY);

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("positions unavailable");
    expect(result.current.data).toBeUndefined();
    // retry: 1 means the original call plus exactly one retry.
    expect(getPositions).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by public key and refetches when the wallet changes", async () => {
    getPositions
      .mockResolvedValueOnce({ positions: POSITIONS })
      .mockResolvedValueOnce({ positions: [] });
    const { result, rerender, client } = setup(KEY);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(["positions", KEY])).toEqual(POSITIONS);

    rerender({ key: OTHER_KEY });

    await waitFor(() => expect(getPositions).toHaveBeenCalledWith(OTHER_KEY));
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(client.getQueryData(["positions", OTHER_KEY])).toEqual([]);
    // The first wallet's entry is untouched.
    expect(client.getQueryData(["positions", KEY])).toEqual(POSITIONS);
  });

  it("uses a 30s stale time", async () => {
    getPositions.mockResolvedValue({ positions: POSITIONS });
    const { result, client } = setup(KEY);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = client.getQueryCache().find({ queryKey: ["positions", KEY] });
    expect(query?.isStale()).toBe(false);
    expect(query?.observers[0]?.options.staleTime).toBe(30_000);
  });
});
