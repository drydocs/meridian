import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Mock @tanstack/react-query so we can assert query-key, enabled-gating,
// and the success / loading / error states without spinning up a real
// QueryClient (the production react-query machinery is exercised by the
// integration suites; here we only need the hook's own contract).
vi.mock("@tanstack/react-query", () => {
  const { useEffect, useReducer } = require("react");

  type State = {
    status: "pending" | "success" | "error";
    data: unknown;
    error: Error | null;
  };

  function useQuery(options: {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
    staleTime?: number;
    retry?: number;
  }) {
    const [state, dispatch] = useReducer(
      (_s: State, a: Partial<State> & { type?: string }) => {
        if (a.type === "success") return { status: "success", data: a.data, error: null };
        if (a.type === "error") return { status: "error", data: undefined, error: a.error ?? new Error("error") };
        if (a.type === "pending") return { status: "pending", data: undefined, error: null };
        return _s;
      },
      { status: "pending", data: undefined, error: null } as State
    );

    useEffect(() => {
      if (!options.enabled) return;
      let cancelled = false;
      dispatch({ type: "pending" });
      options
        .queryFn()
        .then((data) => {
          if (cancelled) return;
          dispatch({ type: "success", data });
        })
        .catch((err) => {
          if (cancelled) return;
          dispatch({ type: "error", error: err });
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [options.enabled, JSON.stringify(options.queryKey)]);

    return state;
  }

  return { useQuery };
});

vi.mock("../../lib/api", () => ({
  api: {
    getAdminHistory: vi.fn(),
  },
}));

import { useAdminHistory } from "../../hooks/useAdminHistory";
import { api } from "../../lib/api";

const VAULT_ID = "VAULT-1";
const ADMIN_ACTION = {
  id: "a1",
  type: "deploy",
  timestamp: "2026-09-29T00:00:00Z",
  transactionHash: "HASH",
  sourceAccount: "G_SOURCE",
  summary: "deployed",
  details: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAdminHistory (#970)", () => {
  it("issues a request for the given vaultId and surfaces success data", async () => {
    vi.mocked(api.getAdminHistory).mockResolvedValue([ADMIN_ACTION]);

    const { result } = renderHook(() => useAdminHistory(VAULT_ID));

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });

    expect(api.getAdminHistory).toHaveBeenCalledWith(VAULT_ID);
    expect(result.current.data).toEqual([ADMIN_ACTION]);
  });

  it("surfaces a loading state before the request resolves", async () => {
    let resolveQuery: (v: unknown) => void = () => {};
    vi.mocked(api.getAdminHistory).mockImplementation(
      () => new Promise((r) => {
        resolveQuery = r;
      })
    );

    const { result } = renderHook(() => useAdminHistory(VAULT_ID));

    expect(result.current.status).toBe("pending");

    // Resolve now and confirm we leave loading.
    resolveQuery([ADMIN_ACTION]);
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
  });

  it("surfaces an error state when the request rejects", async () => {
    vi.mocked(api.getAdminHistory).mockRejectedValue(new Error("rpc down"));

    const { result } = renderHook(() => useAdminHistory(VAULT_ID));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("does not issue a request when vaultId is null (enabled gating)", () => {
    const { result } = renderHook(() => useAdminHistory(null));

    expect(api.getAdminHistory).not.toHaveBeenCalled();
    expect(result.current.status).toBe("pending");
  });

  it("issues a fresh request when the vaultId changes (query-key instability)", async () => {
    vi.mocked(api.getAdminHistory).mockResolvedValue([ADMIN_ACTION]);

    let vaultId = "VAULT-1";
    const { result, rerender } = renderHook(() => useAdminHistory(vaultId));

    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(api.getAdminHistory).toHaveBeenCalledWith("VAULT-1");

    vaultId = "VAULT-2";
    rerender();

    await waitFor(() => expect(api.getAdminHistory).toHaveBeenCalledWith("VAULT-2"));
  });
});
