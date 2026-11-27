import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { AdminLogin } from "../../pages/AdminLogin";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { getAdminToken, loginAsAdmin } from "../../lib/adminSession";
import { getWalletAdapter } from "../../lib/wallet";
import en from "../../../messages/en.json";

const ADMIN = "GCKFBEIYTKP6RCZNVPH73XL7XFJVSFAKQR4E4XQD4PGGPCCQTVMWXW6D";
const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const handleConnect = vi.fn();
const disconnect = vi.fn();

vi.mock("../../hooks/useWalletConnect", () => ({ useWalletConnect: vi.fn() }));
vi.mock("../../lib/adminSession", () => ({
  getAdminToken: vi.fn(() => null),
  clearAdminToken: vi.fn(),
  onAdminSessionChange: vi.fn(() => () => undefined),
  loginAsAdmin: vi.fn(),
}));
vi.mock("../../lib/wallet", () => ({
  getSelectedWalletId: vi.fn(() => "freighter"),
  getWalletAdapter: vi.fn(() => ({ signMessage: vi.fn() })),
}));
vi.mock("../../pages/AdminDashboard", () => ({
  AdminDashboard: () => <div data-testid="admin-dashboard" />,
}));

function renderPage() {
  const instance = createInstance();
  void instance.init({
    resources: { en: { translation: en } },
    lng: "en",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return render(
    <I18nextProvider i18n={instance}>
      <AdminLogin />
    </I18nextProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({ publicKey: null, connected: false, disconnect });
  vi.mocked(useWalletConnect).mockReturnValue({
    handleConnect,
    status: "idle",
    attemptedWalletId: "freighter",
    showRiskDisclosure: false,
    acceptRiskDisclosure: vi.fn(),
    cancelRiskDisclosure: vi.fn(),
    cancelConnect: vi.fn(),
    retryConnect: vi.fn(),
  } as ReturnType<typeof useWalletConnect>);
});

describe("AdminLogin", () => {
  it("connects before showing the sign-in action", () => {
    renderPage();
    fireEvent.click(screen.getByText(en.common.connectWallet));
    expect(handleConnect).toHaveBeenCalledOnce();
  });

  it("runs challenge/sign/verify and opens the dashboard", async () => {
    vi.mocked(loginAsAdmin).mockResolvedValueOnce();
    vi.mocked(getAdminToken).mockReturnValue("token");
    useWalletStore.setState({ publicKey: ADMIN, connected: true, disconnect });
    renderPage();
    fireEvent.click(screen.getByText(en.admin.signIn));
    await waitFor(() =>
      expect(screen.getByTestId("admin-dashboard")).toBeDefined()
    );
    expect(loginAsAdmin).toHaveBeenCalledWith(ADMIN, expect.anything());
  });

  it("blocks a non-admin wallet when verification returns 403", async () => {
    const error = Object.assign(new Error("forbidden"), { status: 403 });
    vi.mocked(loginAsAdmin).mockRejectedValueOnce(error);
    useWalletStore.setState({ publicKey: OTHER, connected: true, disconnect });
    renderPage();
    fireEvent.click(screen.getByText(en.admin.signIn));
    await waitFor(() =>
      expect(screen.getByText(en.admin.notAuthorized)).toBeDefined()
    );
  });

  it("explains that a wallet without message signing cannot log in", () => {
    vi.mocked(getWalletAdapter).mockReturnValue({} as never);
    useWalletStore.setState({ publicKey: OTHER, connected: true, disconnect });
    renderPage();
    expect(screen.getByText(en.admin.walletCannotSign)).toBeDefined();
  });
});
