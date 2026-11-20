import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(async () => ({ isConnected: true })),
  isAllowed: vi.fn(async () => ({ isAllowed: true })),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@lobstrco/signer-extension-api", () => ({
  isConnected: vi.fn(async () => true),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@creit.tech/xbull-wallet-connect", () => ({
  xBullWalletConnect: vi.fn(),
}));

vi.mock("@albedo-link/intent", () => ({
  default: { publicKey: vi.fn(), tx: vi.fn() },
}));

import {
  isAllowed as freighterIsAllowed,
  isConnected as freighterIsConnected,
  requestAccess,
  signTransaction as freighterSign,
} from "@stellar/freighter-api";
import {
  FreighterWallet,
  WalletCancelledError,
  WalletTimeoutError,
  WALLET_TIMEOUTS,
  isWalletCancellation,
  isWalletTimeout,
} from "../../lib/wallet";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// A promise that never settles, standing in for a wallet popup that the
// browser blocked or that opened behind the browser window (#1301).
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (window as unknown as { __E2E_MOCK_WALLET__?: unknown })
    .__E2E_MOCK_WALLET__;
});

describe("wallet timeouts (#1301)", () => {
  it("rejects connect with a typed timeout instead of hanging", async () => {
    vi.mocked(requestAccess).mockReturnValue(never());
    const wallet = new FreighterWallet();

    await expect(wallet.connect({ timeoutMs: 10 })).rejects.toBeInstanceOf(
      WalletTimeoutError
    );
  });

  it("rejects sign with a typed timeout instead of hanging", async () => {
    vi.mocked(freighterSign).mockReturnValue(never());
    const wallet = new FreighterWallet();

    const err = await wallet
      .sign("XDR", "Test SDF Network ; September 2015", { timeoutMs: 10 })
      .catch((e: unknown) => e);

    expect(isWalletTimeout(err)).toBe(true);
    expect(err).toBeInstanceOf(WalletTimeoutError);
    expect((err as WalletTimeoutError).code).toBe("WALLET_TIMEOUT");
    expect((err as WalletTimeoutError).operation).toBe("sign");
  });

  it("rejects isInstalled with a typed timeout instead of hanging", async () => {
    vi.mocked(freighterIsConnected).mockReturnValue(never());
    const wallet = new FreighterWallet();

    const err = await wallet
      .isInstalled({ timeoutMs: 10 })
      .catch((e: unknown) => e);

    expect(isWalletTimeout(err)).toBe(true);
    expect((err as WalletTimeoutError).operation).toBe("isInstalled");
  });

  it("rejects isAuthorized with a typed timeout instead of hanging", async () => {
    // isInstalled resolves, so the hang comes from the permission check.
    vi.mocked(freighterIsConnected).mockResolvedValue({ isConnected: true });
    vi.mocked(freighterIsAllowed).mockReturnValue(never());
    const wallet = new FreighterWallet();

    const err = await wallet
      .isAuthorized({ timeoutMs: 10 })
      .catch((e: unknown) => e);

    expect(isWalletTimeout(err)).toBe(true);
    expect((err as WalletTimeoutError).operation).toBe("isAuthorized");
  });

  it("rejects immediately with a cancel error when the signal is already aborted", async () => {
    const wallet = new FreighterWallet();
    const controller = new AbortController();
    controller.abort();

    const err = await wallet
      .connect({ signal: controller.signal })
      .catch((e: unknown) => e);

    expect(isWalletCancellation(err)).toBe(true);
    expect((err as WalletCancelledError).operation).toBe("connect");
    // Never even asked the wallet.
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("abandons a pending connect when the caller aborts", async () => {
    vi.mocked(requestAccess).mockReturnValue(never());
    const wallet = new FreighterWallet();
    const controller = new AbortController();

    const pending = wallet.connect({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(WalletCancelledError);
  });

  it("ignores a wallet answer that arrives after the caller cancelled", async () => {
    let resolveAccess: (value: { address: string }) => void = () => {};
    vi.mocked(requestAccess).mockReturnValue(
      new Promise((resolve) => {
        resolveAccess = resolve as (value: { address: string }) => void;
      })
    );
    const wallet = new FreighterWallet();
    const controller = new AbortController();

    const pending = wallet.connect({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WalletCancelledError);

    // The popup finally answers; the cancelled call must stay cancelled.
    resolveAccess({ address: ADDRESS });
    await expect(pending).rejects.toBeInstanceOf(WalletCancelledError);
  });

  it("does not fire a timeout after the operation already resolved", async () => {
    vi.useFakeTimers();
    vi.mocked(requestAccess).mockResolvedValue({ address: ADDRESS });
    const wallet = new FreighterWallet();

    await expect(wallet.connect({ timeoutMs: 1000 })).resolves.toBe(ADDRESS);

    // Advance past the deadline: no late rejection, no unhandled error.
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses generous per-operation deadlines for the interactive calls", () => {
    expect(WALLET_TIMEOUTS.connect).toBeGreaterThanOrEqual(30_000);
    expect(WALLET_TIMEOUTS.sign).toBeGreaterThanOrEqual(60_000);
    expect(WALLET_TIMEOUTS.isInstalled).toBeLessThan(WALLET_TIMEOUTS.connect);
  });

  it("still resolves normally when the wallet answers in time", async () => {
    vi.mocked(requestAccess).mockResolvedValue({ address: ADDRESS });
    const wallet = new FreighterWallet();

    await expect(wallet.connect({ timeoutMs: 1000 })).resolves.toBe(ADDRESS);
  });
});
