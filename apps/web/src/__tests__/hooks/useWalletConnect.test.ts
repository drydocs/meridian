import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { WalletCancelledError, WalletTimeoutError } from "../../lib/wallet";

const freighterAdapter = { isInstalled: vi.fn(), connect: vi.fn() };
const lobstrAdapter = { isInstalled: vi.fn(), connect: vi.fn() };

let selectedWalletId = "freighter";
let riskDisclosureAccepted = true;

vi.mock("../../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/wallet")>();
  return {
    ...actual,
    getSelectedWalletId: () => selectedWalletId,
    setSelectedWalletId: vi.fn((id: string) => {
      selectedWalletId = id;
    }),
    getWalletAdapter: (id: string) =>
      id === "lobstr" ? lobstrAdapter : freighterAdapter,
    hasAcceptedRiskDisclosure: () => riskDisclosureAccepted,
    setRiskDisclosureAccepted: vi.fn(() => {
      riskDisclosureAccepted = true;
    }),
  };
});

vi.mock("react-i18next", () => {
  const translations: Record<string, string> = {
    "walletConnect.disconnect": "Disconnect",
    "walletConnect.copyAddress": "Copy Address",
    "walletConnect.copied": "Copied",
    "common.installWallet": "Install {{name}}",
    "common.connectWallet": "Connect Wallet",
    "common.connecting": "Connecting...",
    "walletConnect.walletDisconnected": "Wallet Disconnected",
    "walletConnect.walletConnected": "Wallet Connected",
  };

  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  selectedWalletId = "freighter";
  riskDisclosureAccepted = true;
  useWalletStore.setState({
    publicKey: null,
    connected: false,
    network: "testnet",
  });
  useToastStore.setState({ toasts: [] });
  vi.clearAllMocks();
});

describe("useWalletConnect", () => {
  it("defaults to the persisted selected wallet when no walletId is given", async () => {
    selectedWalletId = "lobstr";
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(lobstrAdapter.connect).toHaveBeenCalledOnce();
    expect(freighterAdapter.connect).not.toHaveBeenCalled();
  });

  it("connects through an explicitly chosen wallet, not the persisted selection", async () => {
    selectedWalletId = "freighter";
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect("lobstr"));

    expect(lobstrAdapter.connect).toHaveBeenCalledOnce();
    expect(freighterAdapter.connect).not.toHaveBeenCalled();
  });

  it("sets status to no-extension when the chosen wallet is not installed", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(false);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("no-extension");
    expect(result.current.attemptedWalletId).toBe("freighter");
    expect(useWalletStore.getState().connected).toBe(false);
  });

  it("connects and resets to idle on success", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("idle");
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "success",
    });
  });

  it("does not persist the selection when connect fails", async () => {
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect("lobstr"));

    expect(selectedWalletId).toBe("freighter");
  });

  it("swallows user-cancel errors without a toast", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockRejectedValue(
      new Error("User declined request")
    );
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("idle");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("shows an error toast for unexpected connect failures", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockRejectedValue(
      new Error("Network error")
    );
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("idle");
    // "Network error" is an unmapped error; mapError returns the
    // errors.unknownWithRef key (the t() stub in this test returns the key
    // as-is with its interpolation params appended).
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error",
      message: expect.stringContaining("errors.unknownWithRef"),
    });
  });
});

describe("useWalletConnect — risk disclosure gate (#720)", () => {
  it("shows the risk disclosure instead of connecting when not yet accepted", async () => {
    riskDisclosureAccepted = false;
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.showRiskDisclosure).toBe(true);
    expect(freighterAdapter.connect).not.toHaveBeenCalled();
    expect(useWalletStore.getState().connected).toBe(false);
  });

  it("only connects once accepted, through the wallet that was originally requested", async () => {
    riskDisclosureAccepted = false;
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect("lobstr"));
    expect(lobstrAdapter.connect).not.toHaveBeenCalled();

    await act(() => result.current.acceptRiskDisclosure());

    expect(lobstrAdapter.connect).toHaveBeenCalledOnce();
    expect(result.current.showRiskDisclosure).toBe(false);
  });

  it("never connects when the disclosure is cancelled", async () => {
    riskDisclosureAccepted = false;
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());
    act(() => result.current.cancelRiskDisclosure());

    expect(result.current.showRiskDisclosure).toBe(false);
    expect(freighterAdapter.connect).not.toHaveBeenCalled();
    expect(useWalletStore.getState().connected).toBe(false);
  });

  it("connects immediately, with no gate, once already accepted", async () => {
    riskDisclosureAccepted = true;
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.showRiskDisclosure).toBe(false);
    expect(freighterAdapter.connect).toHaveBeenCalledOnce();
  });

  it("skips the gate entirely for a call site that opts out, even when not yet accepted", async () => {
    riskDisclosureAccepted = false;
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockResolvedValue(KEY);
    const { result } = renderHook(() =>
      useWalletConnect({ skipRiskDisclosure: true })
    );

    await act(() => result.current.handleConnect());

    expect(result.current.showRiskDisclosure).toBe(false);
    expect(freighterAdapter.connect).toHaveBeenCalledOnce();
  });
});

describe("useWalletConnect — timeouts and cancellation", () => {
  it("returns to idle on cancel without changing the persisted selection", async () => {
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    // Never resolves on its own; only the abort signal can settle it, which is
    // the same shape as a wallet popup blocked behind the browser.
    vi.mocked(lobstrAdapter.connect).mockImplementation(
      (options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new WalletCancelledError("connect"))
          );
        })
    );
    const { result } = renderHook(() => useWalletConnect());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleConnect("lobstr");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("connecting");

    act(() => result.current.cancelConnect());
    await act(async () => {
      await pending;
    });

    expect(result.current.status).toBe("idle");
    expect(selectedWalletId).toBe("freighter");
    expect(useWalletStore.getState().connected).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("enters timed-out and keeps the attempted wallet when connect times out", async () => {
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect).mockRejectedValue(
      new WalletTimeoutError("connect", 90_000)
    );
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect("lobstr"));

    expect(result.current.status).toBe("timed-out");
    expect(result.current.attemptedWalletId).toBe("lobstr");
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error",
    });
    // A timeout is not a successful connect, so the selection stays put.
    expect(selectedWalletId).toBe("freighter");
    expect(useWalletStore.getState().connected).toBe(false);
  });

  it("times out the install check as well", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockRejectedValue(
      new WalletTimeoutError("install", 5_000)
    );
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("timed-out");
    expect(freighterAdapter.connect).not.toHaveBeenCalled();
  });

  it("retryConnect re-runs the wallet that timed out", async () => {
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect)
      .mockRejectedValueOnce(new WalletTimeoutError("connect", 90_000))
      .mockResolvedValueOnce(KEY);
    const { result } = renderHook(() => useWalletConnect());

    await act(() => result.current.handleConnect("lobstr"));
    expect(result.current.status).toBe("timed-out");

    await act(async () => {
      result.current.retryConnect();
    });

    expect(lobstrAdapter.connect).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("idle");
    expect(selectedWalletId).toBe("lobstr");
    expect(useWalletStore.getState().connected).toBe(true);
  });
});
