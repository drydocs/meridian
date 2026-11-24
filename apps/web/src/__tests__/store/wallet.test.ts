import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWalletStore } from "../../store/wallet";
import { APP_NETWORK } from "@meridian/shared";

vi.mock("../../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/wallet")>();
  return {
    ...actual,
    wallet: {
      isAuthorized: vi.fn(),
    },
  };
});

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
});
