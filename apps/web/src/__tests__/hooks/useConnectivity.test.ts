import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../../lib/api";
import { useConnectivity } from "../../hooks/useConnectivity";

function setNavigatorOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
}

afterEach(() => {
  setNavigatorOnline(true);
  vi.restoreAllMocks();
});

describe("useConnectivity", () => {
  it("starts offline and becomes online again after a reconnect event", () => {
    setNavigatorOnline(false);
    const client = new QueryClient();
    const refetch = vi
      .spyOn(client, "refetchQueries")
      .mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useConnectivity(client));

    expect(result.current).toBe(false);

    act(() => window.dispatchEvent(new Event("online")));

    expect(result.current).toBe(true);
    expect(refetch).toHaveBeenCalledWith({ type: "active" });
    unmount();
    client.clear();
  });

  it("shows offline state after a network request fails and clears on reconnect", async () => {
    setNavigatorOnline(true);
    const client = new QueryClient();
    const { result, unmount } = renderHook(() => useConnectivity(client));

    const request = client.fetchQuery({
      queryKey: ["network-failure"],
      retry: false,
      queryFn: async () => {
        throw new ApiRequestError("connection lost", {
          method: "GET",
          path: "/api/v1/vaults",
          status: null,
          category: "network_error",
        });
      },
    });
    await expect(request).rejects.toThrow("connection lost");
    await waitFor(() => expect(result.current).toBe(false));

    act(() => window.dispatchEvent(new Event("online")));

    expect(result.current).toBe(true);
    unmount();
    client.clear();
  });
});
