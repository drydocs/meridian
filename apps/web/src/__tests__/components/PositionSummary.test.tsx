import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PositionSummary } from "../../components/dashboard/PositionSummary";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

describe("PositionSummary freshness", () => {
  it("shows localized freshness labels for stale cached positions", () => {
    render(
      <PositionSummary
        position={{
          vaultId: "meridian-usdc",
          shares: 100,
          deposited: 100,
          earned: 1.5,
          entryTime: 1_700_000_000,
        }}
        lastUpdated={Date.UTC(2026, 0, 1, 12, 30)}
        isStale
      />
    );

    expect(screen.getByText("status.stale")).toBeTruthy();
    expect(screen.getByText(/status.lastUpdated/)).toBeTruthy();
  });
});
