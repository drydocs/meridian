import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WalletConnect } from "../../components/onboarding/WalletConnect";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { useWalletConnect } from "../../hooks/useWalletConnect";

const handleConnect = vi.fn();
const acceptRiskDisclosure = vi.fn();
const cancelRiskDisclosure = vi.fn();
const { freighterInstalled, lobstrInstalled } = vi.hoisted(() => ({
  freighterInstalled: vi.fn(async () => true),
  lobstrInstalled: vi.fn(async () => false),
}));

vi.mock("../../hooks/useWalletConnect", () => ({
  useWalletConnect: vi.fn(),
}));

vi.mock("../../lib/wallet", () => ({
  WALLETS: [
    {
      id: "freighter",
      name: "Freighter",
      installUrl: "https://freighter.app",
      adapter: { isInstalled: freighterInstalled },
    },
    {
      id: "lobstr",
      name: "LOBSTR",
      installUrl: "https://lobstr.co",
      adapter: { isInstalled: lobstrInstalled },
    },
  ],
  getWalletMeta: (id: string) =>
    id === "lobstr"
      ? { id, name: "LOBSTR", installUrl: "https://lobstr.co" }
      : { id, name: "Freighter", installUrl: "https://freighter.app" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

function mockConnect(overrides: Partial<ReturnType<typeof useWalletConnect>>) {
  vi.mocked(useWalletConnect).mockReturnValue({
    handleConnect,
    status: "idle",
    attemptedWalletId: "freighter",
    showRiskDisclosure: false,
    acceptRiskDisclosure,
    cancelRiskDisclosure,
    ...overrides,
  } as ReturnType<typeof useWalletConnect>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({ publicKey: null, connected: false });
  mockConnect({});
});

describe("WalletConnect — connected state", () => {
  it("shows the shortened address and a disconnect control", () => {
    useWalletStore.setState({
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      connected: true,
    });
    render(<WalletConnect />);

    expect(screen.getByText("GBBD...FLA5")).toBeDefined();
    expect(screen.getByText("walletConnect.disconnect")).toBeDefined();
  });
});

describe("WalletConnect — no-extension fallback", () => {
  it("opens the wallet's own install page in a new tab when it is not installed", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    render(<WalletConnect />);
    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));

    // Wait for isInstalled() to resolve so the picker knows lobstr is missing.
    await waitFor(() => {
      const lobstrRow = screen.getByTestId("wallet-picker-option-lobstr");
      expect(lobstrRow.textContent).toContain("walletConnect.install");
    });

    fireEvent.click(screen.getByTestId("wallet-picker-option-lobstr"));

    expect(openSpy).toHaveBeenCalledWith(
      "https://lobstr.co",
      "_blank",
      "noopener,noreferrer"
    );
    expect(handleConnect).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("WalletConnect — picker", () => {
  it("plain click opens the picker and does not connect immediately", () => {
    render(<WalletConnect />);

    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));

    expect(screen.getByTestId("wallet-picker-menu")).toBeDefined();
    expect(handleConnect).not.toHaveBeenCalled();
  });

  it("opens a menu listing every implemented wallet", async () => {
    render(<WalletConnect />);

    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));

    await waitFor(() => {
      expect(
        screen.getByTestId("wallet-picker-option-freighter")
      ).toBeDefined();
    });
    expect(screen.getByTestId("wallet-picker-option-lobstr")).toBeDefined();
  });

  it("shows an Installed badge only for wallets isInstalled() resolves true for", async () => {
    render(<WalletConnect />);
    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));

    await waitFor(() => {
      const freighterRow = screen.getByTestId("wallet-picker-option-freighter");
      expect(freighterRow.textContent).toContain("walletConnect.installed");
    });
    const lobstrRow = screen.getByTestId("wallet-picker-option-lobstr");
    expect(lobstrRow.textContent).not.toContain("walletConnect.installed");
  });

  it("connects through the specific wallet clicked in the menu", async () => {
    lobstrInstalled.mockResolvedValueOnce(true);

    render(<WalletConnect />);
    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));

    await waitFor(() => {
      const lobstrRow = screen.getByTestId("wallet-picker-option-lobstr");
      expect(lobstrRow.textContent).toContain("walletConnect.installed");
    });

    fireEvent.click(screen.getByTestId("wallet-picker-option-lobstr"));

    expect(handleConnect).toHaveBeenCalledWith("lobstr");
  });

  it("connects an installed wallet clicked before isInstalled() has resolved", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    render(<WalletConnect />);
    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));
    // Click before the picker's isInstalled() effect populates the cache, so
    // the row's install state is still undefined at click time.
    fireEvent.click(screen.getByTestId("wallet-picker-option-freighter"));

    await waitFor(() => {
      expect(handleConnect).toHaveBeenCalledWith("freighter");
    });
    expect(openSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("closes the menu as soon as a wallet is picked", () => {
    render(<WalletConnect />);
    fireEvent.click(screen.getByTestId("wallet-picker-toggle"));
    expect(screen.getByTestId("wallet-picker-menu")).toBeDefined();

    fireEvent.click(screen.getByTestId("wallet-picker-option-lobstr"));

    expect(screen.queryByTestId("wallet-picker-menu")).toBeNull();
  });

  it("leaves the picker closed after a disconnect, ready for a fresh pick", () => {
    useWalletStore.setState({
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      connected: true,
    });
    const { rerender } = render(<WalletConnect />);

    fireEvent.click(screen.getByText("walletConnect.disconnect"));
    useWalletStore.setState({ publicKey: null, connected: false });
    rerender(<WalletConnect />);

    expect(screen.queryByTestId("wallet-picker-menu")).toBeNull();
  });
});

describe("WalletConnect — risk disclosure gate (#720)", () => {
  it("renders the modal and wires it to the hook's accept/cancel when the hook says to show it", () => {
    mockConnect({ showRiskDisclosure: true });
    render(<WalletConnect />);

    fireEvent.click(screen.getByTestId("risk-disclosure-acknowledgement"));
    fireEvent.click(screen.getByTestId("risk-disclosure-accept"));
    expect(acceptRiskDisclosure).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("risk-disclosure-cancel"));
    expect(cancelRiskDisclosure).toHaveBeenCalledTimes(1);
  });

  it("does not render the modal when the hook says not to", () => {
    mockConnect({ showRiskDisclosure: false });
    render(<WalletConnect />);

    expect(screen.queryByTestId("risk-disclosure")).toBeNull();
  });
});

describe("WalletConnect — copy address", () => {
  it("pushes the translated copyFailed toast when the clipboard write rejects", async () => {
    useWalletStore.setState({
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      connected: true,
    });
    useToastStore.setState({ toasts: [] });
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject()) },
    });
    render(<WalletConnect />);

    fireEvent.click(screen.getByLabelText("walletConnect.copyAddress"));

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toContainEqual(
        expect.objectContaining({
          kind: "error",
          message: "walletConnect.copyFailed",
        })
      );
    });

    vi.unstubAllGlobals();
  });
});
