import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminActionHistory } from "../../components/dashboard/AdminActionHistory";
import { useAdminHistory } from "../../hooks/useAdminHistory";

vi.mock("../../hooks/useAdminHistory", () => ({
  useAdminHistory: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en" },
  }),
}));

const NOW = new Date("2026-06-15T12:00:00.000Z");
const ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    type: "set_paused",
    timestamp: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    transactionHash: "abc123",
    sourceAccount: ACCOUNT,
    summary: "Paused the vault",
    details: {},
    ...overrides,
  };
}

function mock(overrides: Partial<ReturnType<typeof useAdminHistory>>) {
  vi.mocked(useAdminHistory).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    ...overrides,
  } as ReturnType<typeof useAdminHistory>);
}

function renderComponent(
  props: { isAdmin?: boolean; network?: "testnet" | "mainnet" } = {}
) {
  return render(
    <AdminActionHistory
      vaultId="blend-usdc-fixed"
      network={props.network ?? "testnet"}
      isAdmin={props.isAdmin ?? true}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe("AdminActionHistory", () => {
  it("renders nothing and skips the fetch when the user is not an admin", () => {
    mock({ data: { actions: [action()] } as never });
    const { container } = renderComponent({ isAdmin: false });

    expect(container.firstChild).toBeNull();
    expect(useAdminHistory).toHaveBeenCalledWith(null);
  });

  it("requests history for the vault when the user is an admin", () => {
    mock({ data: { actions: [] } as never });
    renderComponent();

    expect(useAdminHistory).toHaveBeenCalledWith("blend-usdc-fixed");
  });

  it("shows a loading skeleton while the history loads", () => {
    mock({ isLoading: true });
    const { container } = renderComponent();

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
    expect(screen.queryByText("No admin actions recorded yet")).toBeNull();
  });

  it("shows an error message when the fetch fails", () => {
    mock({ isError: true });
    renderComponent();

    expect(screen.getByText("Failed to load admin history")).toBeDefined();
  });

  it("shows the empty state when there are no actions", () => {
    mock({ data: { actions: [] } as never });
    renderComponent();

    expect(screen.getByText("No admin actions recorded yet")).toBeDefined();
  });

  it("renders a known action with its badge, summary and truncated account", () => {
    mock({ data: { actions: [action()] } as never });
    renderComponent();

    expect(screen.getByText("Paused")).toBeDefined();
    expect(screen.getByText("Paused the vault")).toBeDefined();
    expect(
      screen.getByText(`${ACCOUNT.slice(0, 8)}...${ACCOUNT.slice(-4)}`)
    ).toBeDefined();
  });

  it("falls back to the raw type as the badge for an unknown action type", () => {
    mock({ data: { actions: [action({ type: "mystery_action" })] } as never });
    renderComponent();

    const badge = screen.getByText("mystery_action");
    expect(badge.className).toContain("text-gray-400");
  });

  it("links to the network-specific explorer", () => {
    mock({ data: { actions: [action()] } as never });
    const { unmount } = renderComponent({ network: "testnet" });
    expect(screen.getByText("View tx").getAttribute("href")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123"
    );
    unmount();

    renderComponent({ network: "mainnet" });
    expect(screen.getByText("View tx").getAttribute("href")).toBe(
      "https://stellar.expert/explorer/public/tx/abc123"
    );
  });

  it.each([
    ["under a minute", 30_000, "Just now"],
    ["minutes", 5 * 60_000, "5m ago"],
    ["hours", 3 * 3_600_000, "3h ago"],
    ["days", 2 * 86_400_000, "2d ago"],
  ])("formats a timestamp %s old as %s", (_label, ageMs, expected) => {
    mock({
      data: {
        actions: [
          action({ timestamp: new Date(NOW.getTime() - ageMs).toISOString() }),
        ],
      } as never,
    });
    renderComponent();

    expect(screen.getByText(expected)).toBeDefined();
  });

  it("formats a timestamp a week or older as a locale date", () => {
    const old = new Date(NOW.getTime() - 10 * 86_400_000);
    mock({
      data: { actions: [action({ timestamp: old.toISOString() })] } as never,
    });
    renderComponent();

    expect(screen.getByText(old.toLocaleDateString())).toBeDefined();
  });
});
