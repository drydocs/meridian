import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

const freighterAdapter = { isInstalled: vi.fn(), connect: vi.fn() };
const lobstrAdapter = { isInstalled: vi.fn(), connect: vi.fn() };

let selectedWalletId = "freighter";
let riskDisclosureAccepted = true;

vi.mock("../../lib/wallet", () => ({
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
  isWalletCancellation: (err: unknown) =>
    err instanceof Error && err.name === "WalletCancelledError",
  isWalletTimeout: (err: unknown) =>
    err instanceof Error && err.name === "WalletTimeoutError",
}));

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
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error",
      message: "Network error",
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

describe("useWalletConnect — timeouts and cancellation (#1301)", () => {
  // Stands in for a wallet popup that never answers: blocked, or opened
  // behind the browser window.
  function never<T>(): Promise<T> {
    return new Promise<T>(() => {});
  }

  function timeoutError() {
    const err = new Error("Wallet connect did not respond");
    err.name = "WalletTimeoutError";
    return err;
  }

  it("leaves connecting and reports timeout when the wallet times out", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    // The adapter's own deadline rejects with a typed timeout; the real
    // never-resolving path is covered in lib/wallet-timeout.test.ts.
    vi.mocked(freighterAdapter.connect).mockRejectedValueOnce(timeoutError());

    const { result } = renderHook(() => useWalletConnect());
    await act(() => result.current.handleConnect());

    expect(result.current.status).toBe("timeout");
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error",
    });
    expect(useWalletStore.getState().connected).toBe(false);
  });

  it("cancel returns to idle without persisting a selection", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    let resolveConnect: (key: string) => void = () => {};
    vi.mocked(freighterAdapter.connect).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        })
    );

    const { result } = renderHook(() => useWalletConnect());
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.handleConnect();
    });
    // Wait for the connect call to be in flight, so status is "connecting".
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("connecting");

    act(() => result.current.cancelConnect());
    expect(result.current.status).toBe("idle");

    // The popup answers after the cancel: the cancelled attempt must not
    // connect, persist, or toast.
    await act(async () => {
      resolveConnect(KEY);
      await pending;
    });

    expect(useWalletStore.getState().connected).toBe(false);
    expect(selectedWalletId).toBe("freighter");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("cancel does not change a previously persisted selection", async () => {
    selectedWalletId = "freighter";
    vi.mocked(lobstrAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(lobstrAdapter.connect).mockImplementation(never);

    const { result } = renderHook(() => useWalletConnect());
    act(() => {
      void result.current.handleConnect("lobstr");
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.cancelConnect());

    expect(selectedWalletId).toBe("freighter");
  });

  it("stays idle when the wallet never answers and the user cancels", async () => {
    vi.mocked(freighterAdapter.isInstalled).mockResolvedValue(true);
    vi.mocked(freighterAdapter.connect).mockImplementation(never);

    const { result } = renderHook(() => useWalletConnect());
    act(() => {
      void result.current.handleConnect();
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.cancelConnect());

    expect(result.current.status).toBe("idle");
  });
});
