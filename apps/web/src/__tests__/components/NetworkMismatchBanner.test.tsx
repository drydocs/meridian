import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_NETWORK, STELLAR_NETWORKS } from "@meridian/shared";
import { NetworkMismatchBanner } from "../../components/onboarding/NetworkMismatchBanner";
import { useWalletStore } from "../../store/wallet";
import { wallet } from "../../lib/wallet";

vi.mock("../../lib/wallet", () => ({
  wallet: { getNetwork: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      `${
        key === "networkMismatch.unknownNetwork" ? "Unknown" : key
      }${values?.network ? `:${values.network}` : ""}${
        values?.error ? `:${values.error}` : ""
      }`,
  }),
}));

const otherNetwork =
  APP_NETWORK.network === "mainnet"
    ? STELLAR_NETWORKS.testnet
    : STELLAR_NETWORKS.mainnet;

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({
    publicKey: "GTEST",
    connected: true,
    walletNetworkName: null,
    walletNetworkPassphrase: null,
    walletNetworkError: null,
    walletNetworkLoading: false,
  });
});

describe("NetworkMismatchBanner", () => {
  it("stays hidden when wallet and app networks match", () => {
    useWalletStore.setState({
      walletNetworkName: APP_NETWORK.network,
      walletNetworkPassphrase: APP_NETWORK.passphrase,
    });

    render(<NetworkMismatchBanner />);

    expect(screen.queryByTestId("network-mismatch-banner")).toBeNull();
  });

  it("shows expected and detected networks when they differ", () => {
    useWalletStore.setState({
      walletNetworkName: otherNetwork.network,
      walletNetworkPassphrase: otherNetwork.passphrase,
    });

    render(<NetworkMismatchBanner />);

    expect(screen.getByRole("alert")).toBeDefined();
    expect(
      screen.getByText(
        `networkMismatch.expected:networkMismatch.${APP_NETWORK.network}`
      )
    ).toBeDefined();
    expect(
      screen.getByText(
        `networkMismatch.detected:networkMismatch.${otherNetwork.network}`
      )
    ).toBeDefined();
    expect(screen.getByText("networkMismatch.message")).toBeDefined();
  });

  it("shows an unknown-network warning", () => {
    render(<NetworkMismatchBanner />);

    expect(screen.getByText("networkMismatch.unknown")).toBeDefined();
    expect(screen.getByText("networkMismatch.detected:Unknown")).toBeDefined();
  });

  it("retries network detection and clears the banner after a switch", async () => {
    useWalletStore.setState({
      walletNetworkName: otherNetwork.network,
      walletNetworkPassphrase: otherNetwork.passphrase,
    });
    vi.mocked(wallet.getNetwork).mockResolvedValue({
      name: APP_NETWORK.network,
      passphrase: APP_NETWORK.passphrase,
    });

    render(<NetworkMismatchBanner />);
    fireEvent.click(screen.getByText("common.retry"));

    await waitFor(() => {
      expect(screen.queryByTestId("network-mismatch-banner")).toBeNull();
    });
    expect(wallet.getNetwork).toHaveBeenCalledOnce();
  });
});
