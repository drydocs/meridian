import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VaultListEmptyState } from "../../components/dashboard/VaultListEmptyState";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en" },
  }),
}));

describe("VaultListEmptyState", () => {
  it("renders distinct empty state for no vaults", () => {
    render(<VaultListEmptyState kind="no-vaults" />);
    expect(screen.getByTestId("vault-empty-none")).toBeTruthy();
    expect(screen.getByText("No vaults available")).toBeTruthy();
    expect(
      screen.getByText(
        "There are currently no active vaults on this network. Please check back later."
      )
    ).toBeTruthy();
    expect(screen.queryByTestId("vault-empty-retry-button")).toBeNull();
  });

  it("renders distinct empty state for failure and triggers retry", () => {
    const onRetry = vi.fn();
    render(<VaultListEmptyState kind="failure" onRetry={onRetry} />);
    expect(screen.getByTestId("vault-empty-failure")).toBeTruthy();
    expect(screen.getByText("Failed to load vaults")).toBeTruthy();
    expect(
      screen.getByText(
        "We couldn't retrieve the latest vault data. Check your network connection and try again."
      )
    ).toBeTruthy();

    const retryButton = screen.getByTestId("vault-empty-retry-button");
    expect(retryButton).toBeTruthy();
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
