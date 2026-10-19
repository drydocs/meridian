import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { AdminLogin } from "../../pages/AdminLogin";
import { useWalletStore } from "../../store/wallet";
import { useWalletConnect } from "../../hooks/useWalletConnect";
import { fetchVaultAdmin } from "@meridian/stellar-sdk-helpers";
import { shortenAddress } from "@meridian/shared";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

function makeI18n(lng: "en" | "fr") {
  const instance = createInstance();
  void instance.init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng,
    fallbackLng: "en",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}

function renderAdminLogin(lng: "en" | "fr" = "en") {
  return render(
    <I18nextProvider i18n={makeI18n(lng)}>
      <AdminLogin />
    </I18nextProvider>
  );
}

const handleConnect = vi.fn();
const ADMIN = "GCKFBEIYTKP6RCZNVPH73XL7XFJVSFAKQR4E4XQD4PGGPCCQTVMWXW6D";
const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

vi.mock("../../hooks/useWalletConnect", () => ({
  useWalletConnect: vi.fn(),
}));
vi.mock("@meridian/stellar-sdk-helpers", () => ({
  fetchVaultAdmin: vi.fn(),
}));
vi.mock("../../pages/AdminDashboard", () => ({
  AdminDashboard: () => <div data-testid="admin-dashboard" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
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
    renderAdminLogin();

    const button = screen.getByText(en.common.connectWallet);
    expect(button).toBeDefined();
    expect(screen.getByText(en.admin.connectPrompt)).toBeDefined();

    fireEvent.click(button);
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it("skips the depositor risk-disclosure gate, since admin auth isn't a deposit", () => {
    renderAdminLogin();

    expect(useWalletConnect).toHaveBeenCalledWith({
      skipRiskDisclosure: true,
    });
    expect(screen.queryByTestId("risk-disclosure")).toBeNull();
  });

  it("shows the blocked screen with only the connected address for a non-admin wallet", async () => {
    vi.mocked(fetchVaultAdmin).mockResolvedValue(ADMIN);
    const disconnect = vi.fn();
    useWalletStore.setState({ publicKey: OTHER, connected: true, disconnect });

    renderAdminLogin();

    await waitFor(() => {
      expect(screen.getByText(en.admin.notAuthorized)).toBeDefined();
    });
    expect(screen.getByText(shortenAddress(OTHER))).toBeDefined();
    expect(screen.queryByText(OTHER)).toBeNull();
    expect(screen.queryByText(ADMIN, { exact: false })).toBeNull();

    fireEvent.click(screen.getByText(en.admin.switchWallet));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows the dashboard shell when the connected wallet matches get_admin", async () => {
    vi.mocked(fetchVaultAdmin).mockResolvedValue(ADMIN);
    useWalletStore.setState({ publicKey: ADMIN, connected: true });

    renderAdminLogin();

    await waitFor(() => {
      expect(screen.getByTestId("admin-dashboard")).toBeDefined();
    });
  });

  it("shows a retryable error screen rather than not authorized when the lookup fails, and retries on click", async () => {
    vi.mocked(fetchVaultAdmin).mockRejectedValueOnce(new Error("rpc down"));
    const disconnect = vi.fn();
    useWalletStore.setState({ publicKey: OTHER, connected: true, disconnect });

    renderAdminLogin();

    await waitFor(() => {
      expect(screen.getByText(en.admin.readError)).toBeDefined();
    });
    expect(screen.queryByText(en.admin.notAuthorized)).toBeNull();
    const retryBtn = screen.getByText(en.common.retry);
    expect(retryBtn).toBeDefined();

    // Clicking retry re-invokes fetchVaultAdmin
    vi.mocked(fetchVaultAdmin).mockResolvedValueOnce(OTHER);
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByTestId("admin-dashboard")).toBeDefined();
    });
    expect(fetchVaultAdmin).toHaveBeenCalledTimes(2);
  });

  it("renders French translated strings in French locale", async () => {
    vi.mocked(fetchVaultAdmin).mockRejectedValueOnce(new Error("rpc down"));
    const disconnect = vi.fn();
    useWalletStore.setState({ publicKey: OTHER, connected: true, disconnect });

    renderAdminLogin("fr");

    await waitFor(() => {
      expect(screen.getByText(fr.admin.readError)).toBeDefined();
    });
    expect(screen.getByText(fr.common.retry)).toBeDefined();
    expect(screen.getByText(fr.admin.switchWallet)).toBeDefined();
    expect(screen.getByText(fr.admin.connected)).toBeDefined();
    expect(screen.queryByText(en.admin.readError)).toBeNull();
  });

  it("renders French not-authorized string in French locale", async () => {
    vi.mocked(fetchVaultAdmin).mockResolvedValue(ADMIN);
    useWalletStore.setState({ publicKey: OTHER, connected: true });

    renderAdminLogin("fr");

    await waitFor(() => {
      expect(screen.getByText(fr.admin.notAuthorized)).toBeDefined();
    });
    expect(screen.getByText(fr.admin.switchWallet)).toBeDefined();
    expect(screen.getByText(fr.admin.connected)).toBeDefined();
    expect(screen.queryByText(en.admin.notAuthorized)).toBeNull();
  });

  it("renders French connect prompt in French locale", () => {
    renderAdminLogin("fr");

    expect(screen.getByText(fr.admin.access)).toBeDefined();
    expect(screen.getByText(fr.admin.connectPrompt)).toBeDefined();
    expect(screen.getByText(fr.common.connectWallet)).toBeDefined();
    expect(screen.queryByText(en.admin.connectPrompt)).toBeNull();
  });
});
