import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { APP_NETWORK, STELLAR_NETWORKS } from "@meridian/shared";
import { useSignAndSubmit } from "../../hooks/useSignAndSubmit";
import { useWalletStore } from "../../store/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// The network this build is not on. Used to show the passphrase tracks the
// build rather than whatever the persisted store happens to hold (#851).
const OTHER_NETWORK = APP_NETWORK.network === "testnet" ? "mainnet" : "testnet";

vi.mock("../../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/wallet")>();
  return {
    ...actual,
    wallet: {
      sign: vi.fn(async () => "SIGNED_XDR"),
      isAuthorized: vi.fn(async () => true),
      getNetwork: vi.fn(async () => APP_NETWORK.network),
      getAddress: vi.fn(async () => KEY),
    },
  };
});

vi.mock("../../lib/api", () => ({
  api: {
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
  },
}));

import { api } from "../../lib/api";
import { wallet, WalletCancelledError } from "../../lib/wallet";
import { WALLET_DISCONNECTED_ERROR } from "../../lib/errorMapper";

describe("useSignAndSubmit (#965)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wallet.sign).mockImplementation(async () => "SIGNED_XDR");
    vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
    vi.mocked(wallet.getNetwork!).mockResolvedValue(APP_NETWORK.network);
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

      expect(wallet.sign).toHaveBeenCalledWith(
        "XDR",
        APP_NETWORK.passphrase,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });
  });

  describe("disconnected guard", () => {
    it("throws and does not sign or submit when no wallet is connected", async () => {
      useWalletStore.setState({ publicKey: null, connected: false });
      const { result } = renderHook(() => useSignAndSubmit());

      // The guard throws a stable, locale-independent code (not the
      // translated string) so mapError can detect it in every locale.
      await expect(result.current.signAndSubmit("XDR")).rejects.toThrow(
        WALLET_DISCONNECTED_ERROR
      );
      expect(wallet.sign).not.toHaveBeenCalled();
      expect(api.submitTx).not.toHaveBeenCalled();
    });

    it("throws when revalidation finds the wallet is no longer authorized", async () => {
      vi.mocked(wallet.isAuthorized).mockResolvedValue(false);
      const { result } = renderHook(() => useSignAndSubmit());

      await expect(result.current.signAndSubmit("XDR")).rejects.toThrow(
        WALLET_DISCONNECTED_ERROR
      );
      expect(useWalletStore.getState().connected).toBe(false);
      expect(wallet.sign).not.toHaveBeenCalled();
      expect(api.submitTx).not.toHaveBeenCalled();
    });

    it("blocks signing when there is a network mismatch (#1300)", async () => {
      vi.mocked(wallet.getNetwork!).mockResolvedValue(OTHER_NETWORK);
      const { result } = renderHook(() => useSignAndSubmit());

      await expect(result.current.signAndSubmit("XDR")).rejects.toThrow(
        /network mismatch/i
      );
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
        APP_NETWORK.passphrase,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
      expect(useWalletStore.getState().connected).toBe(true);
    });

    it.each(["PENDING", "OUTCOME_UNKNOWN"] as const)(
      "does not treat %s as a successful submission",
      async (status) => {
        vi.mocked(api.submitTx).mockResolvedValueOnce({
          hash: "TX_HASH",
          status,
        });
        const { result } = renderHook(() => useSignAndSubmit());

        await expect(
          result.current.signAndSubmit("UNSIGNED_XDR")
        ).rejects.toMatchObject({
          name: "TransactionNotConfirmedError",
          status,
          hash: "TX_HASH",
        });
      }
    );
  });
});

describe("useSignAndSubmit — cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
    useWalletStore.setState({
      publicKey: KEY,
      connected: true,
      network: APP_NETWORK.network,
    });
  });

  it("cancelSign aborts a never-resolving signature so the call exits", async () => {
    // Only the abort signal settles this promise, mirroring a wallet popup
    // that is blocked behind the browser and will never answer on its own.
    vi.mocked(wallet.sign).mockImplementation(
      (_xdr, _passphrase, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new WalletCancelledError("sign"))
          );
        })
    );
    const { result } = renderHook(() => useSignAndSubmit());

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.signAndSubmit("XDR");
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.cancelSign());

    await expect(pending).rejects.toBeInstanceOf(WalletCancelledError);
    expect(api.submitTx).not.toHaveBeenCalled();
  });

  it("passes the same abort signal to the authorization check and the signature", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.mocked(wallet.isAuthorized).mockImplementation(async (options) => {
      signals.push(options?.signal);
      return true;
    });
    vi.mocked(wallet.sign).mockImplementation(async (_xdr, _pass, options) => {
      signals.push(options?.signal);
      return "SIGNED_XDR";
    });
    const { result } = renderHook(() => useSignAndSubmit());

    await result.current.signAndSubmit("XDR");

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).toBe(signals[1]);
  });
});
