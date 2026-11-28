import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { ApiRequestError } from "../../lib/api";
import {
  createQueryClient,
  queryRetryDelay,
  shouldRetryQuery,
} from "../../lib/queryClient";

function apiError(status: number) {
  return new ApiRequestError(`request failed: ${status}`, {
    method: "GET",
    path: "/api/v1/vaults",
    status,
    category: status >= 500 ? "http_server_error" : "http_client_error",
  });
}

function setup(queryFn: () => Promise<string>) {
  const client = createQueryClient();
  client.setQueryDefaults(["retry-test"], { retryDelay: 0 });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () => useQuery({ queryKey: ["retry-test"], queryFn }),
    { wrapper }
  );
  return { client, ...hook };
}

describe("query client retry defaults", () => {
  it("retries transient 5xx responses with a bounded attempt count", async () => {
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue("available");
    const { client, result, unmount } = setup(queryFn);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toBe("available");
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(shouldRetryQuery(2, apiError(503))).toBe(true);
    expect(shouldRetryQuery(3, apiError(503))).toBe(false);
    expect(queryRetryDelay(0)).toBe(1_000);
    expect(queryRetryDelay(20)).toBe(30_000);
    unmount();
    client.clear();
  });

  it("does not retry 4xx responses", async () => {
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(apiError(404));
    const { client, result, unmount } = setup(queryFn);

    await act(async () => {
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(shouldRetryQuery(0, apiError(404))).toBe(false);
    unmount();
    client.clear();
  });
});
