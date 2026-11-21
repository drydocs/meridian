import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VaultStatePanel } from "../../components/admin/VaultStatePanel";
import { useVaultState } from "../../hooks/useVaultState";
import { useAdminAuth } from "../../hooks/useAdminAuth";
import { useWallet } from "../../hooks/useWallet";

const refetch = vi.fn();
const signAndSubmit = vi.fn();

vi.mock("../../hooks/useVaultState", () => ({
  useVaultState: vi.fn(),
}));

vi.mock("../../hooks/useAdminAuth", () => ({
  useAdminAuth: vi.fn(),
}));

vi.mock("../../hooks/useWallet", () => ({
  useWallet: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => (opts?.text ? `${key}:${opts.text}` : key),
    i18n: { language: "en" },
  }),
}));

function mockVault(overrides: Partial<ReturnType<typeof useVaultState>>) {
  vi.mocked(useVaultState).mockReturnValue({
    data: {
      protocol: "blend",
      adapterId: "CADAPTER",
      totalShares: 1234.5,
      totalAssets: 1300.25,
      paused: false,
    },
    isLoading: false,
    isError: false,
    refetch,
    ...overrides,
  } as ReturnType<typeof useVaultState>);
}

function mockAuth(isAdmin: boolean) {
  vi.mocked(useAdminAuth).mockReturnValue({
    isAdmin,
    isLoading: false,
  } as any);
}

function mockWallet() {
  vi.mocked(useWallet).mockReturnValue({
    address: "GADMIN...",
    signAndSubmit,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth(true);
  mockWallet();
});

describe("VaultStatePanel", () => {
  it("shows an error state with a retry button when the fetch fails", () => {
    mockVault({ data: undefined, isError: true });
    render(<VaultStatePanel />);

    expect(screen.getByText("admin.vaultState.loadError")).toBeDefined();
    fireEvent.click(screen.getByText("common.retry"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the resolved protocol label, shares, assets, and an Active badge", () => {
    mockVault({});
    render(<VaultStatePanel />);

    expect(screen.getByText("Blend Capital")).toBeDefined();
    expect(screen.getByText("1,234.50")).toBeDefined();
    expect(screen.getByText("1,300.25")).toBeDefined();
    const badge = screen.getByTestId("vault-state-badge");
    expect(badge.textContent).toBe("admin.vaultState.active");
    expect(badge.className).toContain("text-emerald-400");
  });

  it("does not show pause button if user is not admin", () => {
    mockAuth(false);
    mockVault({});
    render(<VaultStatePanel />);

    expect(screen.queryByText("admin.vaultState.pause")).toBeNull();
  });

  it("requires typed confirmation before building transaction", async () => {
    mockVault({});
    render(<VaultStatePanel />);

    fireEvent.click(screen.getByText("admin.vaultState.pause"));
    expect(screen.getByTestId("vault-confirm-input")).toBeDefined();

    const executeBtn = screen.getByTestId("vault-confirm-execute-btn");
    expect(executeBtn.getAttribute("disabled")).not.toBeNull();

    fireEvent.change(screen.getByTestId("vault-confirm-input"), { target: { value: "wrong" } });
    expect(executeBtn.getAttribute("disabled")).not.toBeNull();

    fireEvent.change(screen.getByTestId("vault-confirm-input"), { target: { value: "PAUSE" } });
    expect(executeBtn.getAttribute("disabled")).toBeNull();
  });

  it("builds, signs, submits, and refreshes vault state on success", async () => {
    mockVault({});
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ xdr: "AAAAXDR..." }),
    } as Response);

    signAndSubmit.mockResolvedValueOnce("txhash123");

    render(<VaultStatePanel />);

    fireEvent.click(screen.getByText("admin.vaultState.pause"));
    fireEvent.change(screen.getByTestId("vault-confirm-input"), { target: { value: "PAUSE" } });
    fireEvent.click(screen.getByTestId("vault-confirm-execute-btn"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/tx/set_paused", expect.any(Object));
      expect(signAndSubmit).toHaveBeenCalledWith("AAAAXDR...");
      expect(screen.getByTestId("vault-tx-success")).toBeDefined();
      expect(screen.getByTestId("vault-explorer-link").getAttribute("href")).toContain("txhash123");
      expect(refetch).toHaveBeenCalled();
    });
  });

  it("shows failure state if transaction building fails", async () => {
    mockVault({});
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "Server error" }),
    } as Response);

    render(<VaultStatePanel />);

    fireEvent.click(screen.getByText("admin.vaultState.pause"));
    fireEvent.change(screen.getByTestId("vault-confirm-input"), { target: { value: "PAUSE" } });
    fireEvent.click(screen.getByTestId("vault-confirm-execute-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("vault-tx-error").textContent).toContain("Server error");
    });
  });
});
