import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";
import { queryClient } from "../../lib/queryClient";
import { APP_NETWORK } from "@meridian/shared";

vi.mock("../../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/wallet")>();
  return {
    ...actual,
    wallet: {
      isAuthorized: vi.fn(),
      getAddress: vi.fn(),
      getNetwork: vi.fn(),
    },
  };
});

vi.mock("../../lib/queryClient", () => ({
  queryClient: {
    invalidateQueries: vi.fn(),
  },
}));

vi.mock("../../store/toast", () => ({
  useToastStore: {
    getState: vi.fn(() => ({
      push: vi.fn(),
    })),
  },
}));

import {
  wallet,
  WalletTimeoutError,
  WalletCancelledError,
} from "../../lib/wallet";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  useWalletStore.setState({
    publicKey: null,
    connected: false,
    // Use APP_NETWORK.network so the reset matches the store's actual default
    // and doesn't mask regressions if the build network changes (#851).
    network: APP_NETWORK.network,
  });
  vi.clearAllMocks();
});

describe("useWalletStore", () => {
  it("connect sets publicKey and marks connected", () => {
    useWalletStore.getState().connect(KEY);
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("disconnect clears publicKey and marks disconnected", () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    useWalletStore.getState().disconnect();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: null,
      connected: false,
    });
  });

  it("revalidate does nothing when no publicKey is set", async () => {
    await useWalletStore.getState().revalidate();
    expect(wallet.isAuthorized).not.toHaveBeenCalled();
  });

  it("revalidate keeps connection when site is still authorized", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
    await useWalletStore.getState().revalidate();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("revalidate disconnects when site access was revoked", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    vi.mocked(wallet.isAuthorized).mockResolvedValue(false);
    await useWalletStore.getState().revalidate();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: null,
      connected: false,
    });
  });

  it("revalidate keeps the session when the authorization check times out", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    vi.mocked(wallet.isAuthorized).mockRejectedValue(
      new WalletTimeoutError("authorize", 10_000)
    );

    await expect(
      useWalletStore.getState().revalidate()
    ).resolves.toBeUndefined();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("revalidate keeps the session when the authorization check is cancelled", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    vi.mocked(wallet.isAuthorized).mockRejectedValue(
      new WalletCancelledError("authorize")
    );

    await expect(
      useWalletStore.getState().revalidate()
    ).resolves.toBeUndefined();
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("revalidate surfaces deadline errors to a caller that passed a signal", async () => {
    useWalletStore.setState({ publicKey: KEY, connected: true });
    const timeout = new WalletTimeoutError("authorize", 10_000);
    vi.mocked(wallet.isAuthorized).mockRejectedValue(timeout);
    const controller = new AbortController();

    await expect(
      useWalletStore.getState().revalidate(controller.signal)
    ).rejects.toBe(timeout);
    expect(useWalletStore.getState()).toMatchObject({
      publicKey: KEY,
      connected: true,
    });
  });

  it("revalidate keeps a wallet connected while a stale check was in flight", async () => {
    const OTHER_KEY =
      "GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG";
    let resolveCheck: (authorized: boolean) => void = () => {};
    vi.mocked(wallet.isAuthorized).mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveCheck = resolve;
      })
    );

    useWalletStore.setState({ publicKey: KEY, connected: true });
    const pending = useWalletStore.getState().revalidate();

    useWalletStore.getState().connect(OTHER_KEY);
    resolveCheck(false);
    await pending;

    expect(useWalletStore.getState()).toMatchObject({
      publicKey: OTHER_KEY,
      connected: true,
    });
  });

  describe("passive reconciliation (#1300)", () => {
    it("updates store, shows toast, and invalidates queries on account switch", async () => {
      const NEW_KEY =
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      useWalletStore.setState({ publicKey: KEY, connected: true });
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockResolvedValue(NEW_KEY);
      vi.mocked(wallet.getNetwork!).mockResolvedValue(APP_NETWORK.network);

      await useWalletStore.getState().revalidate();

      expect(useWalletStore.getState().publicKey).toBe(NEW_KEY);
      expect(pushMock).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("switched")
      );
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["positions"],
      });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["vaults"],
      });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["vault-state"],
      });
    });

    it("updates store, shows toast, and invalidates queries on network switch", async () => {
      const NEW_NETWORK =
        APP_NETWORK.network === "mainnet" ? "testnet" : "mainnet";
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      useWalletStore.setState({
        publicKey: KEY,
        connected: true,
        network: APP_NETWORK.network,
      });
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockResolvedValue(KEY);
      vi.mocked(wallet.getNetwork!).mockResolvedValue(NEW_NETWORK);

      await useWalletStore.getState().revalidate();

      expect(useWalletStore.getState().network).toBe(NEW_NETWORK);
      expect(pushMock).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("switched")
      );
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["positions"],
      });
    });

    it("makes no changes and shows no toast on unchanged focus", async () => {
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      useWalletStore.setState({
        publicKey: KEY,
        connected: true,
        network: APP_NETWORK.network,
      });
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockResolvedValue(KEY);
      vi.mocked(wallet.getNetwork!).mockResolvedValue(APP_NETWORK.network);

      await useWalletStore.getState().revalidate();

      expect(useWalletStore.getState().publicKey).toBe(KEY);
      expect(useWalletStore.getState().network).toBe(APP_NETWORK.network);
      expect(pushMock).not.toHaveBeenCalled();
      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it("does not update store, show toast, or reconnect if user disconnects while getAddress is pending", async () => {
      const NEW_KEY =
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      let resolveAddress: (addr: string | null) => void = () => {};
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockReturnValue(
        new Promise((resolve) => {
          resolveAddress = resolve;
        })
      );

      useWalletStore.setState({ publicKey: KEY, connected: true });
      const pending = useWalletStore.getState().revalidate();

      // User disconnects while getAddress is in flight
      useWalletStore.getState().disconnect();
      expect(useWalletStore.getState().publicKey).toBeNull();
      expect(useWalletStore.getState().connected).toBe(false);

      // getAddress resolves with a new address
      resolveAddress(NEW_KEY);
      await pending;

      // Must remain disconnected, no toast, no query invalidation
      expect(useWalletStore.getState().publicKey).toBeNull();
      expect(useWalletStore.getState().connected).toBe(false);
      expect(pushMock).not.toHaveBeenCalled();
      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it("does not overwrite a newer session if user connects a different wallet while getAddress is pending", async () => {
      const STALE_KEY =
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
      const OTHER_KEY =
        "GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTGG";
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      let resolveAddress: (addr: string | null) => void = () => {};
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockReturnValue(
        new Promise((resolve) => {
          resolveAddress = resolve;
        })
      );

      useWalletStore.setState({ publicKey: KEY, connected: true });
      const pending = useWalletStore.getState().revalidate();

      // Connect another wallet while getAddress is in flight
      useWalletStore.getState().connect(OTHER_KEY);

      resolveAddress(STALE_KEY);
      await pending;

      expect(useWalletStore.getState().publicKey).toBe(OTHER_KEY);
      expect(useWalletStore.getState().connected).toBe(true);
      expect(pushMock).not.toHaveBeenCalled();
      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it("does not update network, show toast, or invalidate queries if user disconnects while getNetwork is pending", async () => {
      const NEW_NETWORK =
        APP_NETWORK.network === "mainnet" ? "testnet" : "mainnet";
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      let resolveNetwork: (net: string | null) => void = () => {};
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockResolvedValue(KEY);
      vi.mocked(wallet.getNetwork!).mockReturnValue(
        new Promise((resolve) => {
          resolveNetwork = resolve;
        })
      );

      useWalletStore.setState({
        publicKey: KEY,
        connected: true,
        network: APP_NETWORK.network,
      });
      const pending = useWalletStore.getState().revalidate();

      // User disconnects while getNetwork is in flight
      useWalletStore.getState().disconnect();

      resolveNetwork(NEW_NETWORK);
      await pending;

      // Network must remain unchanged, no toast, no query invalidation
      expect(useWalletStore.getState().publicKey).toBeNull();
      expect(useWalletStore.getState().connected).toBe(false);
      expect(useWalletStore.getState().network).toBe(APP_NETWORK.network);
      expect(pushMock).not.toHaveBeenCalled();
      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it("handles a wallet without passive reporting (null/undefined getters)", async () => {
      const pushMock = vi.fn();
      vi.mocked(useToastStore.getState).mockReturnValue({
        push: pushMock,
      } as unknown as ReturnType<typeof useToastStore.getState>);

      useWalletStore.setState({
        publicKey: KEY,
        connected: true,
        network: APP_NETWORK.network,
      });
      vi.mocked(wallet.isAuthorized).mockResolvedValue(true);
      vi.mocked(wallet.getAddress!).mockResolvedValue(null);
      vi.mocked(wallet.getNetwork!).mockResolvedValue(null);

      await useWalletStore.getState().revalidate();

      expect(useWalletStore.getState().publicKey).toBe(KEY);
      expect(useWalletStore.getState().network).toBe(APP_NETWORK.network);
      expect(pushMock).not.toHaveBeenCalled();
      expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    });
  });
});
