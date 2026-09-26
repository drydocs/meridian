import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePositionPolling } from "../../hooks/usePositionPolling";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

vi.mock("@tanstack/react-query", async () => {
  const { useEffect, useRef, useState } = await import("react");

  function useQuery(options: {
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
    refetchInterval?: (query: {
      state: { status: string; data: unknown };
    }) => number | false;
  }) {
    const [state, setState] = useState<{ status: string; data: unknown }>({
      status: "pending",
      data: undefined,
    });
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (!options.enabled) return;
      let cancelled = false;

      function scheduleNext(current: { status: string; data: unknown }) {
        const next = options.refetchInterval?.({ state: current });
        if (next === false || next === undefined) return;
        timerRef.current = setTimeout(tick, next);
      }

      async function tick() {
        try {
          const data = await options.queryFn();
          if (cancelled) return;
          const next = { status: "success", data };
          setState(next);
          scheduleNext(next);
        } catch {
          if (cancelled) return;
          const next = { status: "error", data: undefined };
          setState(next);
          scheduleNext(next);
        }
      }

      void tick();
      return () => {
        cancelled = true;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [options.enabled]);

    return state;
  }

  return { useQuery };
});

vi.mock("../../lib/api", () => ({
  api: {
    getPositions: vi.fn(async () => ({ positions: [] })),
  },
}));

vi.mock("react-i18next", () => {
  const translations: Record<string, string> = {
    "vaultActions.syncDelayed": "Updating your balance...",
  };
  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

import { api } from "../../lib/api";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  useWalletStore.setState({
    publicKey: KEY,
    connected: true,
    network: "testnet",
  });
  useToastStore.setState({ toasts: [] });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePositionPolling", () => {
  it("logs and surfaces a toast after repeated sync failures", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.getPositions).mockRejectedValue(new Error("RPC down"));

    const { result } = renderHook(() => usePositionPolling());

    act(() => {
      result.current.startPolling("blend-usdc-fixed", 100);
    });

    // Initial 3s delay before polling starts, then 3 failed attempts at 3s intervals.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
    }

    expect(warnSpy).toHaveBeenCalledWith("[positions poll] failed, attempt", 3);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({
        kind: "info",
        message: "Updating your balance...",
      })
    );

    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stops polling when the component unmounts mid-poll", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getPositions).mockRejectedValue(new Error("RPC down"));

    const { result, unmount } = renderHook(() => usePositionPolling());

    act(() => {
      result.current.startPolling("blend-usdc-fixed", 100);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const callsBeforeUnmount = vi.mocked(api.getPositions).mock.calls.length;

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(vi.mocked(api.getPositions).mock.calls.length).toBe(
      callsBeforeUnmount
    );

    vi.useRealTimers();
  });

  it("does not activate polling if unmounted before the 3s activation delay", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getPositions).mockResolvedValue({ positions: [] });

    const { result, unmount } = renderHook(() => usePositionPolling());

    act(() => {
      result.current.startPolling("blend-usdc-fixed", 100);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(api.getPositions).not.toHaveBeenCalled();

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(api.getPositions).not.toHaveBeenCalled();
  });

  it("keeps polling a deposit until the live share count rises above the baseline", async () => {
    vi.useFakeTimers();
    const positions: Array<{ vaultId: string; shares: number }> = [
      { vaultId: "blend-usdc-fixed", shares: 100 },
    ];
    vi.mocked(api.getPositions).mockImplementation(async () => ({
      positions: positions as never,
    }));

    const { result } = renderHook(() => usePositionPolling());

    act(() => {
      result.current.startPolling("blend-usdc-fixed", 100, "increase");
    });

    // First tick after the 3s activation delay: shares are unchanged, so the
    // deposit has not landed yet and polling must continue.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const callsAfterNoMove = vi.mocked(api.getPositions).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(vi.mocked(api.getPositions).mock.calls.length).toBeGreaterThan(
      callsAfterNoMove
    );

    // Deposit reflected on-chain: shares exceed the pre-deposit baseline.
    positions[0].shares = 110;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const callsAfterSettle = vi.mocked(api.getPositions).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(vi.mocked(api.getPositions).mock.calls.length).toBe(
      callsAfterSettle
    );

    vi.useRealTimers();
  });

  it("settles a deposit with no cached baseline once a positive position appears", async () => {
    vi.useFakeTimers();
    const positions: Array<{ vaultId: string; shares: number }> = [];
    vi.mocked(api.getPositions).mockImplementation(async () => ({
      positions: positions as never,
    }));

    const { result } = renderHook(() => usePositionPolling());

    act(() => {
      // Infinity mirrors a wallet with no cached position before the deposit.
      result.current.startPolling("blend-usdc-fixed", Infinity, "increase");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const callsWithNoPosition = vi.mocked(api.getPositions).mock.calls.length;

    positions.push({ vaultId: "blend-usdc-fixed", shares: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const callsAfterSettle = vi.mocked(api.getPositions).mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(callsAfterSettle).toBeGreaterThan(callsWithNoPosition);
    expect(vi.mocked(api.getPositions).mock.calls.length).toBe(
      callsAfterSettle
    );

    vi.useRealTimers();
  });
});
