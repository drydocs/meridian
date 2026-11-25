import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { ActivityHistory } from "../../components/dashboard/ActivityHistory";
import { useActivityStore, type LocalActivity } from "../../store/activity";
import { useWalletStore } from "../../store/wallet";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_KEY = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

function activity(overrides: Partial<LocalActivity> = {}): LocalActivity {
  return {
    id: "a1",
    action: "deposit",
    amount: "10",
    asset: "USDC",
    vaultId: "meridian-usdc",
    publicKey: KEY,
    timestamp: "2026-11-20T10:00:00.000Z",
    status: "pending",
    ...overrides,
  };
}

function renderHistory(onRetry = vi.fn()) {
  const i18n = createInstance();
  void i18n.init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: "en",
    fallbackLng: "en",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <ActivityHistory onRetry={onRetry} />
    </I18nextProvider>
  );
  return onRetry;
}

beforeEach(() => {
  useActivityStore.setState({ activities: [], latestReceipt: null });
  useWalletStore.setState({ publicKey: KEY });
});

describe("ActivityHistory", () => {
  it("shows pending, confirmed and failed actions with distinct labels", () => {
    useActivityStore.setState({
      activities: [
        activity({ id: "p", status: "pending" }),
        activity({ id: "c", status: "confirmed", transactionHash: "abc123" }),
        activity({ id: "f", status: "failed", error: "rejected" }),
      ],
    });
    renderHistory();

    const items = screen.getAllByTestId("local-activity-item");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Pending")).toBeTruthy();
    expect(within(items[1]!).getByText("Confirmed")).toBeTruthy();
    expect(within(items[2]!).getByText("Failed")).toBeTruthy();
  });

  it("links a confirmed action to the transaction explorer", () => {
    useActivityStore.setState({
      activities: [
        activity({ status: "confirmed", transactionHash: "abc123" }),
      ],
    });
    renderHistory();

    const link = screen.getByText("View tx").closest("a");
    expect(link?.getAttribute("href")).toContain("abc123");
  });

  it("offers a retry only for failed actions", () => {
    useActivityStore.setState({
      activities: [
        activity({ id: "c", status: "confirmed", transactionHash: "abc123" }),
        activity({ id: "f", status: "failed" }),
      ],
    });
    const onRetry = renderHistory();

    const retry = screen.getAllByText("Retry");
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0]!);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "f", status: "failed" })
    );
  });

  it("shows the latest receipt and dismisses it", () => {
    const receipt = activity({
      status: "confirmed",
      transactionHash: "abc123",
    });
    useActivityStore.setState({
      activities: [receipt],
      latestReceipt: receipt,
    });
    renderHistory();

    expect(screen.getByTestId("action-receipt")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss receipt"));
    expect(screen.queryByTestId("action-receipt")).toBeNull();
    expect(screen.getAllByTestId("local-activity-item")).toHaveLength(1);
  });

  it("hides activity recorded for a different wallet", () => {
    const foreign = activity({ id: "x", publicKey: OTHER_KEY });
    useActivityStore.setState({
      activities: [foreign],
      latestReceipt: foreign,
    });
    renderHistory();

    expect(screen.queryByTestId("local-activity-item")).toBeNull();
    expect(screen.queryByTestId("action-receipt")).toBeNull();
  });
});
