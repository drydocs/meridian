import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AdminLogin } from "../../pages/AdminLogin";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { shortenAddress } from "@meridian/shared";
import { api } from "../../lib/api";
import { wallet } from "../../lib/wallet";
import { clearAdminSession } from "../../lib/adminSession";

const handleConnect = vi.fn();
const ADMIN = "GCKFBEIYTKP6RCZNVPH73XL7XFJVSFAKQR4E4XQD4PGGPCCQTVMWXW6D";
const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

vi.mock("../../hooks/useWalletConnect", () => ({
  useWalletConnect: vi.fn(),
}));
vi.mock("../../lib/api", () => ({
  api: {
    getAdminChallenge: vi.fn(),
    verifyAdminChallenge: vi.fn(),
  },
}));
vi.mock("../../lib/adminSession", () => ({
  clearAdminSession: vi.fn(),
  setAdminSessionToken: vi.fn(),
}));
vi.mock("../../lib/wallet", () => ({
  wallet: { signMessage: vi.fn() },
}));
vi.mock("../../pages/AdminDashboard", () => ({
  AdminDashboard: ({ onLogout }: { onLogout?: () => void }) => (
    <div data-testid="admin-dashboard">
      <button onClick={onLogout}>Dashboard logout</button>
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getAdminChallenge).mockResolvedValue({
    challenge: "challenge",
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(wallet.signMessage!).mockResolvedValue("signature");
  vi.mocked(api.verifyAdminChallenge).mockResolvedValue({
    token: "token",
    expiresAt: Date.now() + 60_000,
  });
  useWalletStore.setState({ publicKey: null, connected: false });
  vi.mocked(useWalletConnect).mockReturnValue({
    handleConnect,
    status: "idle",
    attemptedWalletId: "freighter",
    showRiskDisclosure: false,
    acceptRiskDisclosure: vi.fn(),
    cancelRiskDisclosure: vi.fn(),
  } as ReturnType<typeof useWalletConnect>);
});

describe("AdminLogin", () => {
  it("shows the connect prompt when no wallet is connected", () => {
    render(<AdminLogin />);

    const button = screen.getByText("Connect Wallet");
    expect(button).toBeDefined();

    fireEvent.click(button);
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it("skips the depositor risk-disclosure gate, since admin auth isn't a deposit", () => {
    render(<AdminLogin />);

    expect(useWalletConnect).toHaveBeenCalledWith({
      skipRiskDisclosure: true,
    });
    expect(screen.queryByTestId("risk-disclosure")).toBeNull();
  });

  it("shows the blocked screen with only the connected address for a non-admin wallet", async () => {
    vi.mocked(api.verifyAdminChallenge).mockRejectedValue(
      new Error("Admin access required")
    );
    const disconnect = vi.fn();
    useWalletStore.setState({ publicKey: OTHER, connected: true, disconnect });

    render(<AdminLogin />);

    await waitFor(() => expect(screen.getByText("Not authorized")).toBeDefined());
    expect(screen.getByText(shortenAddress(OTHER))).toBeDefined();
    expect(screen.queryByText(OTHER)).toBeNull();
    expect(screen.queryByText(ADMIN, { exact: false })).toBeNull();

    fireEvent.click(screen.getByText("Switch Wallet"));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows the dashboard shell after the wallet signs the challenge", async () => {
    useWalletStore.setState({ publicKey: ADMIN, connected: true });

    render(<AdminLogin />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-dashboard")).toBeDefined();
    });
  });

  it("clears the session when the dashboard logs out", async () => {
    useWalletStore.setState({ publicKey: ADMIN, connected: true });
    render(<AdminLogin />);

    await waitFor(() => expect(screen.getByTestId("admin-dashboard")).toBeDefined());
    fireEvent.click(screen.getByText("Dashboard logout"));
    expect(clearAdminSession).toHaveBeenCalled();
  });

  it("treats a failed challenge or signature as blocked", async () => {
    vi.mocked(api.getAdminChallenge).mockRejectedValue(new Error("rpc down"));
    useWalletStore.setState({ publicKey: OTHER, connected: true });

    render(<AdminLogin />);

    await waitFor(() => {
      expect(screen.getByText("Not authorized")).toBeDefined();
    });
  });
});
