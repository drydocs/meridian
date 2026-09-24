import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRiskDisclosure } from "../../hooks/useRiskDisclosure";
import { hasAcceptedRiskDisclosure } from "../../lib/wallet";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useRiskDisclosure (#814)", () => {
  it("runs the action immediately, with no modal, once already accepted", () => {
    window.localStorage.setItem("meridian-risk-disclosure-accepted", "true");
    const action = vi.fn();
    const { result } = renderHook(() => useRiskDisclosure());

    act(() => {
      void result.current.requireAcceptance(action);
    });

    expect(action).toHaveBeenCalledOnce();
    expect(result.current.show).toBe(false);
  });

  it("holds the action and shows the modal when not yet accepted", () => {
    const action = vi.fn();
    const { result } = renderHook(() => useRiskDisclosure());

    act(() => {
      void result.current.requireAcceptance(action);
    });

    expect(action).not.toHaveBeenCalled();
    expect(result.current.show).toBe(true);
  });

  it("persists acceptance, hides the modal and runs the held action on accept", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRiskDisclosure());

    act(() => {
      void result.current.requireAcceptance(action);
    });
    await act(() => result.current.accept());

    expect(action).toHaveBeenCalledOnce();
    expect(result.current.show).toBe(false);
    expect(hasAcceptedRiskDisclosure()).toBe(true);
  });

  it("never runs the held action when cancelled, and does not persist acceptance", () => {
    const action = vi.fn();
    const { result } = renderHook(() => useRiskDisclosure());

    act(() => {
      void result.current.requireAcceptance(action);
    });
    act(() => result.current.cancel());

    expect(action).not.toHaveBeenCalled();
    expect(result.current.show).toBe(false);
    expect(hasAcceptedRiskDisclosure()).toBe(false);
  });

  it("does not replay a cancelled action on a later accept", async () => {
    const cancelled = vi.fn();
    const { result } = renderHook(() => useRiskDisclosure());

    act(() => {
      void result.current.requireAcceptance(cancelled);
    });
    act(() => result.current.cancel());
    await act(async () => {
      await result.current.accept();
    });

    expect(cancelled).not.toHaveBeenCalled();
  });

  it("runs only the most recently gated action on accept", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useRiskDisclosure());

    act(() => {
      void result.current.requireAcceptance(first);
    });
    act(() => {
      void result.current.requireAcceptance(second);
    });
    await act(async () => {
      await result.current.accept();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
