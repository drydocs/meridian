import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { APP_NETWORK, STELLAR_NETWORKS } from "@meridian/shared";
import { useSignAndSubmit } from "../../hooks/useSignAndSubmit";
import { useWalletStore } from "../../store/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// The network this build is not on. Used to show the passphrase tracks the
// build rather than whatever the persisted store happens to hold (#851).
const OTHER_NETWORK = APP_NETWORK.network === "testnet" ? "mainnet" : "testnet";

vi.mock("../../lib/wallet", () => ({
  wallet: {
    sign: vi.fn(async () => "SIGNED_XDR"),
    isAuthorized: vi.fn(async () => true),
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "walletConnect.walletDisconnected" ? "Wallet disconnected" : key,
  }),
}));

import { api } from "../../lib/api";
import { wallet } from "../../lib/wallet";

describe("useSignAndSubmit (#965)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
    useWalletStore.setState({
      publicKey: KEY,
      connected: true,
      network: APP_NETWORK.network,
    });
  });

  describe("passphrase selection", () => {
    it("uses the build's network passphrase", () => {
      const { result } = renderHook(() => useSignAndSubmit());
      expect(result.current.passphrase).toBe(APP_NETWORK.passphrase);
    });

    it("keeps the build's passphrase when the store holds the other network", () => {
      useWalletStore.setState({ network: OTHER_NETWORK });
      const { result } = renderHook(() => useSignAndSubmit());

      expect(result.current.passphrase).toBe(APP_NETWORK.passphrase);
      expect(result.current.passphrase).not.toBe(
        STELLAR_NETWORKS[OTHER_NETWORK].passphrase
      );
    });

    it("signs with the build's passphrase, not the store's network", async () => {
      useWalletStore.setState({ network: OTHER_NETWORK });
      const { result } = renderHook(() => useSignAndSubmit());

      await result.current.signAndSubmit("XDR");

      expect(wallet.sign).toHaveBeenCalledWith("XDR", APP_NETWORK.passphrase);
    });
  });

  describe("disconnected guard", () => {
    it("throws and does not sign or submit when no wallet is connected", async () => {
      useWalletStore.setState({ publicKey: null, connected: false });
      const { result } = renderHook(() => useSignAndSubmit());

      await expect(result.current.signAndSubmit("XDR")).rejects.toThrow(
        "Wallet disconnected"
      );
      expect(wallet.sign).not.toHaveBeenCalled();
      expect(api.submitTx).not.toHaveBeenCalled();
    });

    it("throws when revalidation finds the wallet is no longer authorized", async () => {
      vi.mocked(wallet.isAuthorized).mockResolvedValue(false);
      const { result } = renderHook(() => useSignAndSubmit());

      await expect(result.current.signAndSubmit("XDR")).rejects.toThrow(
        "Wallet disconnected"
      );
      expect(useWalletStore.getState().connected).toBe(false);
      expect(wallet.sign).not.toHaveBeenCalled();
      expect(api.submitTx).not.toHaveBeenCalled();
    });
  });

  describe("revalidation on success", () => {
    it("revalidates the wallet before signing, then submits the signed XDR", async () => {
      const order: string[] = [];
      vi.mocked(wallet.isAuthorized).mockImplementation(async () => {
        order.push("revalidate");
        return true;
      });
      vi.mocked(wallet.sign).mockImplementation(async () => {
        order.push("sign");
        return "SIGNED_XDR";
      });
      vi.mocked(api.submitTx).mockImplementation(async () => {
        order.push("submit");
        return { hash: "TX_HASH" };
      });

      const { result } = renderHook(() => useSignAndSubmit());
      await result.current.signAndSubmit("UNSIGNED_XDR");

      expect(order).toEqual(["revalidate", "sign", "submit"]);
      expect(wallet.sign).toHaveBeenCalledWith(
        "UNSIGNED_XDR",
        APP_NETWORK.passphrase
      );
      expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
      expect(useWalletStore.getState().connected).toBe(true);
    });
  });
});
