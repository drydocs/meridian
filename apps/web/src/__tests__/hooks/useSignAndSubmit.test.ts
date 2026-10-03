import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { STELLAR_NETWORKS } from "@meridian/shared";
import { useSignAndSubmit } from "../../hooks/useSignAndSubmit";
import { useWalletStore } from "../../store/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

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

describe("useSignAndSubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
    useWalletStore.setState({
      publicKey: KEY,
      connected: true,
      network: "testnet",
    });
  });

  describe("passphrase selection", () => {
    it("uses the testnet passphrase on testnet", () => {
      const { result } = renderHook(() => useSignAndSubmit());
      expect(result.current.passphrase).toBe(
        STELLAR_NETWORKS.testnet.passphrase
      );
    });

    it("uses the mainnet passphrase on mainnet", () => {
      useWalletStore.setState({ network: "mainnet" });
      const { result } = renderHook(() => useSignAndSubmit());
      expect(result.current.passphrase).toBe(
        STELLAR_NETWORKS.mainnet.passphrase
      );
      expect(result.current.passphrase).not.toBe(
        STELLAR_NETWORKS.testnet.passphrase
      );
    });

    it("is undefined for an unknown network", () => {
      useWalletStore.setState({
        network: "bogus" as unknown as "testnet",
      });
      const { result } = renderHook(() => useSignAndSubmit());
      expect(result.current.passphrase).toBeUndefined();
    });

    it("signs with the passphrase of the active network", async () => {
      useWalletStore.setState({ network: "mainnet" });
      const { result } = renderHook(() => useSignAndSubmit());
      await result.current.signAndSubmit("XDR");
      expect(wallet.sign).toHaveBeenCalledWith(
        "XDR",
        STELLAR_NETWORKS.mainnet.passphrase
      );
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
        STELLAR_NETWORKS.testnet.passphrase
      );
      expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
      expect(useWalletStore.getState().connected).toBe(true);
    });
  });
});
