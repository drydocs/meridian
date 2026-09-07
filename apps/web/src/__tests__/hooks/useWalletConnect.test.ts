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
});
