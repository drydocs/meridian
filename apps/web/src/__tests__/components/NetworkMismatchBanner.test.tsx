import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { APP_NETWORK } from "@meridian/shared";
import { NetworkMismatchBanner } from "../../components/ui/NetworkMismatchBanner";
import { useWalletStore } from "../../store/wallet";

vi.mock("../../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/wallet")>();
  return {
    ...actual,
    wallet: {
      ...actual.wallet,
      getNetwork: vi.fn(),
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === "walletConnect.networkMismatch") {
        return `Wallet on ${values?.walletNetwork}; app requires ${values?.appNetwork}`;
      }
      if (key === "walletConnect.networkUnknown") {
        return `Wallet network unknown; app requires ${values?.appNetwork}`;
      }
      if (key.startsWith("walletConnect.networks.")) {
        return key.endsWith(".mainnet") ? "Mainnet" : "Testnet";
      }
      return key;
    },
  }),
}));

import { wallet } from "../../lib/wallet";

const OTHER_NETWORK =
  APP_NETWORK.network === "mainnet" ? "testnet" : "mainnet";

beforeEach(() => {
  useWalletStore.setState({
    publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    connected: true,
    network: APP_NETWORK.network,
    walletNetwork: APP_NETWORK.network,
  });
  vi.mocked(wallet.getNetwork!).mockResolvedValue(APP_NETWORK.network);
});

describe("NetworkMismatchBanner", () => {
  it("does not render when the wallet network matches the app", () => {
    render(<NetworkMismatchBanner />);

    expect(screen.queryByTestId("network-mismatch-banner")).toBeNull();
  });

  it("shows expected and detected networks when they differ", () => {
    useWalletStore.setState({ walletNetwork: OTHER_NETWORK });
    render(<NetworkMismatchBanner />);

    expect(screen.getByRole("alert").textContent).toContain(
      `Wallet on ${OTHER_NETWORK === "mainnet" ? "Mainnet" : "Testnet"}`
    );
    expect(screen.getByRole("alert").textContent).toContain(
      `app requires ${APP_NETWORK.network === "mainnet" ? "Mainnet" : "Testnet"}`
    );
  });

  it("explains an unknown wallet network and clears after retry detects a match", async () => {
    useWalletStore.setState({ walletNetwork: null });
    render(<NetworkMismatchBanner />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Wallet network unknown"
    );

    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));

    await waitFor(() => {
      expect(screen.queryByTestId("network-mismatch-banner")).toBeNull();
    });
  });
});
