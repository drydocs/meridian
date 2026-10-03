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
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function action(id: string, type: string, timestamp: string) {
  return {
    id,
    type,
    timestamp,
    transactionHash: `hash-${id}`,
    sourceAccount: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    summary: `summary-${id}`,
    details: {},
  };
}

function mockHistory(actions: ReturnType<typeof action>[]) {
  vi.mocked(useAdminHistory).mockReturnValue({
    data: { actions },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useAdminHistory>);
}

// Real catalogues so the assertions cover the shipped en.json / fr.json.
function renderHistory(lng: "en" | "fr" = "en") {
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
      <AdminActionHistory vaultId="v1" network="testnet" isAdmin />
    </I18nextProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
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
    mockHistory(types.map((t, i) => action(String(i), t, ago(MIN))));
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
    mockHistory(types.map((t, i) => action(String(i), t, ago(MIN))));
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
    mockHistory([action("x", "some_new_action", ago(MIN))]);
    renderHistory("en");

    expect(screen.getByText("some_new_action")).toBeDefined();
  });
});

describe("AdminActionHistory relative timestamps", () => {
  it.each([
    [10_000, "Just now", "À l'instant"],
    [1 * MIN, "1 minute ago", "il y a 1 minute"],
    [5 * MIN, "5 minutes ago", "il y a 5 minutes"],
    [1 * HOUR, "1 hour ago", "il y a 1 heure"],
    [3 * HOUR, "3 hours ago", "il y a 3 heures"],
    [1 * DAY, "1 day ago", "il y a 1 jour"],
    [4 * DAY, "4 days ago", "il y a 4 jours"],
  ])("formats %ims ago with correct pluralization", (elapsed, enText, frText) => {
    mockHistory([action("a", "set_admin", ago(elapsed))]);
    const { unmount } = renderHistory("en");
    expect(screen.getByText(enText)).toBeDefined();
    unmount();

    renderHistory("fr");
    expect(screen.getByText(frText)).toBeDefined();
  });

  it("falls back to a locale-formatted date after a week", () => {
    const iso = ago(10 * DAY);
    mockHistory([action("a", "set_admin", iso)]);
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
      expect(Object.keys(h.actions).sort()).toEqual(
        ["acceptAdmin", "adapter", "migrate", "paused", "setAdmin", "transferAdmin"]
      );
      expect(Object.keys(h.time).sort()).toEqual(
        [
          "daysAgo_one",
          "daysAgo_other",
          "hoursAgo_one",
          "hoursAgo_other",
          "justNow",
          "minutesAgo_one",
          "minutesAgo_other",
        ]
      );
    }
  });
});
