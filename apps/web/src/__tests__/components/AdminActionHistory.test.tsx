import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { AdminActionHistory } from "../../components/dashboard/AdminActionHistory";
import { useAdminHistory } from "../../hooks/useAdminHistory";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

vi.mock("../../hooks/useAdminHistory", () => ({
  useAdminHistory: vi.fn(),
}));

const NOW = new Date("2026-06-15T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    type: "set_paused",
    timestamp: ago(5 * MINUTE),
    transactionHash: "abc123",
    sourceAccount: ACCOUNT,
    summary: "Paused the vault",
    details: {},
    ...overrides,
  };
}

function mock(overrides: Partial<ReturnType<typeof useAdminHistory>> = {}) {
  vi.mocked(useAdminHistory).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    ...overrides,
  } as ReturnType<typeof useAdminHistory>);
}

function mockActions(actions: ReturnType<typeof action>[]) {
  mock({ data: { actions } } as never);
}

// Real catalogues so the assertions cover the shipped en.json / fr.json.
function renderHistory(
  lng: "en" | "fr" = "en",
  props: { isAdmin?: boolean; network?: "testnet" | "mainnet" } = {}
) {
  const i18n = createInstance();
  void i18n.init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng,
    fallbackLng: "en",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <AdminActionHistory
        vaultId="blend-usdc-fixed"
        network={props.network ?? "testnet"}
        isAdmin={props.isAdmin ?? true}
      />
    </I18nextProvider>
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
    mockActions([action()]);
    const { container } = renderHistory("en", { isAdmin: false });

    expect(container.firstChild).toBeNull();
    expect(useAdminHistory).toHaveBeenCalledWith(null);
  });

  it("requests history for the vault when the user is an admin", () => {
    mockActions([]);
    renderHistory();

    expect(useAdminHistory).toHaveBeenCalledWith("blend-usdc-fixed");
  });

  it("shows a loading skeleton while the history loads", () => {
    mock({ isLoading: true });
    const { container } = renderHistory();

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
    expect(screen.queryByText("No admin actions recorded yet")).toBeNull();
  });

  it("shows an error message when the fetch fails", () => {
    mock({ isError: true });
    renderHistory();

    expect(screen.getByText("Failed to load admin history")).toBeDefined();
  });

  it("shows the empty state when there are no actions", () => {
    mockActions([]);
    renderHistory();

    expect(screen.getByText("No admin actions recorded yet")).toBeDefined();
  });

  it("renders a known action with its badge, summary and truncated account", () => {
    mockActions([action()]);
    renderHistory();

    expect(screen.getByText("Paused")).toBeDefined();
    expect(screen.getByText("Paused the vault")).toBeDefined();
    expect(
      screen.getByText(`${ACCOUNT.slice(0, 8)}...${ACCOUNT.slice(-4)}`)
    ).toBeDefined();
  });

  it("falls back to the raw type as the badge for an unknown action type", () => {
    mockActions([action({ type: "mystery_action" })]);
    renderHistory();

    const badge = screen.getByText("mystery_action");
    expect(badge.className).toContain("text-gray-400");
  });

  it("links to the network-specific explorer", () => {
    mockActions([action()]);
    const { unmount } = renderHistory("en", { network: "testnet" });
    expect(screen.getByText("View tx").getAttribute("href")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123"
    );
    unmount();

    renderHistory("en", { network: "mainnet" });
    expect(screen.getByText("View tx").getAttribute("href")).toBe(
      "https://stellar.expert/explorer/public/tx/abc123"
    );
  });

  it("formats a timestamp a week or older as a date in the active locale", () => {
    const old = ago(10 * DAY);
    mockActions([action({ timestamp: old })]);
    renderHistory();

    expect(
      screen.getByText(new Date(old).toLocaleDateString("en"))
    ).toBeDefined();
  });
});

describe("AdminActionHistory badge labels", () => {
  const types = [
    "set_admin",
    "set_paused",
    "set_adapter",
    "migrate_adapter",
    "transfer_admin",
    "accept_admin",
  ];

  it("renders English badge labels for every known action type", () => {
    mockActions(
      types.map((t, i) =>
        action({ id: String(i), type: t, timestamp: ago(MINUTE) })
      )
    );
    renderHistory("en");

    for (const label of [
      "Set Admin",
      "Paused",
      "Adapter",
      "Migrate",
      "Transfer Admin",
      "Accept Admin",
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("renders French badge labels and no English ones", () => {
    mockActions(
      types.map((t, i) =>
        action({ id: String(i), type: t, timestamp: ago(MINUTE) })
      )
    );
    renderHistory("fr");

    for (const label of [
      "Définir l'admin",
      "En pause",
      "Adaptateur",
      "Migration",
      "Transférer l'admin",
      "Accepter l'admin",
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.queryByText("Set Admin")).toBeNull();
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("falls back to the raw type for an unknown action", () => {
    mockActions([action({ type: "some_new_action", timestamp: ago(MINUTE) })]);
    renderHistory("en");

    expect(screen.getByText("some_new_action")).toBeDefined();
  });
});

describe("AdminActionHistory relative timestamps", () => {
  it.each([
    [10_000, "Just now", "À l'instant"],
    [1 * MINUTE, "1 minute ago", "il y a 1 minute"],
    [5 * MINUTE, "5 minutes ago", "il y a 5 minutes"],
    [1 * HOUR, "1 hour ago", "il y a 1 heure"],
    [3 * HOUR, "3 hours ago", "il y a 3 heures"],
    [1 * DAY, "1 day ago", "il y a 1 jour"],
    [4 * DAY, "4 days ago", "il y a 4 jours"],
  ])(
    "formats %ims ago with correct pluralization",
    (elapsed, enText, frText) => {
      mockActions([action({ type: "set_admin", timestamp: ago(elapsed) })]);
      const { unmount } = renderHistory("en");
      expect(screen.getByText(enText)).toBeDefined();
      unmount();

      renderHistory("fr");
      expect(screen.getByText(frText)).toBeDefined();
    }
  );

  it("falls back to a locale-formatted date after a week", () => {
    const iso = ago(10 * DAY);
    mockActions([action({ type: "set_admin", timestamp: iso })]);
    renderHistory("fr");

    expect(
      screen.getByText(new Date(iso).toLocaleDateString("fr"))
    ).toBeDefined();
  });
});

describe("AdminActionHistory catalogues", () => {
  it("defines every new key in both locales", () => {
    for (const catalogue of [en, fr]) {
      const h = catalogue.adminHistory;
      expect(Object.keys(h.actions).sort()).toEqual([
        "acceptAdmin",
        "adapter",
        "migrate",
        "paused",
        "setAdmin",
        "transferAdmin",
      ]);
      expect(Object.keys(h.time).sort()).toEqual([
        "daysAgo_one",
        "daysAgo_other",
        "hoursAgo_one",
        "hoursAgo_other",
        "justNow",
        "minutesAgo_one",
        "minutesAgo_other",
      ]);
    }
  });
});
