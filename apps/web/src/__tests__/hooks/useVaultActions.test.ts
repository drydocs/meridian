import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVaultActions } from "../../hooks/useVaultActions";
import { useWalletStore } from "../../store/wallet";
import { useToastStore } from "../../store/toast";

const invalidateQueries = vi.fn();
const setQueryData = vi.fn();
const getQueryData = vi.fn<(key: unknown[]) => unknown>(() => undefined);
vi.mock("@tanstack/react-query", async () => {
  const { useEffect, useRef, useState } = await import("react");

  function useQuery(options: {
    queryFn: () => Promise<unknown>;
    enabled?: boolean;
    refetchInterval?: (query: {
      state: { status: string; data: unknown };
    }) => number | false;
  }) {
    const [state, setState] = useState<{ status: string; data: unknown }>({
      status: "pending",
      data: undefined,
    });
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (!options.enabled) return;
      let cancelled = false;

      function scheduleNext(current: { status: string; data: unknown }) {
        const next = options.refetchInterval?.({ state: current });
        if (next === false || next === undefined) return;
        timerRef.current = setTimeout(tick, next);
      }

      async function tick() {
        try {
          const data = await options.queryFn();
          if (cancelled) return;
          const next = { status: "success", data };
          setState(next);
          scheduleNext(next);
        } catch {
          if (cancelled) return;
          const next = { status: "error", data: undefined };
          setState(next);
          scheduleNext(next);
        }
      }

      void tick();
      return () => {
        cancelled = true;
        if (timerRef.current) clearTimeout(timerRef.current);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [options.enabled]);

    return state;
  }

  return {
    useQueryClient: () => ({ invalidateQueries, setQueryData, getQueryData }),
    useQuery,
  };
});

vi.mock("../../lib/wallet", () => ({
  wallet: {
    sign: vi.fn(async () => "SIGNED_XDR"),
    isAuthorized: vi.fn(async () => true),
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    addTrustline: vi.fn(async () => ({ xdr: "TRUSTLINE_XDR" })),
    buildDeposit: vi.fn(async () => ({ xdr: "DEPOSIT_XDR" })),
    buildWithdraw: vi.fn(async () => ({ xdr: "WITHDRAW_XDR" })),
    submitTx: vi.fn(async () => ({ hash: "TX_HASH" })),
    getPositions: vi.fn(async () => ({ positions: [] })),
    getVaultState: vi.fn(async () => ({
      protocol: "blend",
      adapterId: "adapter",
      // Live share price = 2.0 (assets/shares) — intentionally different from
      // any stale position.deposited/shares the panel might have cached.
      totalShares: 50,
      totalAssets: 100,
      paused: false,
    })),
  },
}));

vi.mock("react-i18next", () => {
  const translations: Record<string, string> = {
    "vaultActions.deposited": "Deposited",
    "vaultActions.withdrew": "Withdrew",
    "vaultActions.depositFailed": "Deposit failed",
    "vaultActions.withdrawalFailed": "Withdrawal failed",
    "vaultActions.vaultStateUnavailable": "Vault state unavailable",
  };

  return {
    useTranslation: () => ({
      t: (key: string) => translations[key] ?? key,
    }),
  };
});

import { api } from "../../lib/api";
import { wallet } from "../../lib/wallet";
import { USDC_ISSUER, MUSDC_ISSUER, APP_NETWORK } from "@meridian/shared";

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * `setQueryData` calls that write the positions cache. Pricing a slippage
 * floor also writes `["vault-state"]` through the same client, so assertions
 * about the optimistic position have to look past it.
 */
function positionWrites(): unknown[][] {
  return setQueryData.mock.calls.filter(
    (call) => Array.isArray(call[0]) && call[0][0] === "positions"
  ) as unknown[][];
}

// Pulled from the source of truth rather than hardcoded, so these fixtures
// don't drift out of sync the next time the vault (and its mUSDC issuer) is
// redeployed, as happened with the previous hardcoded value in #514.
const BLEND_TESTNET_USDC_ISSUER = USDC_ISSUER.testnet;
const MUSDC_TESTNET_ISSUER = MUSDC_ISSUER.testnet;

function bothTrustlinesHorizonResponse() {
  return new Response(
    JSON.stringify({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: BLEND_TESTNET_USDC_ISSUER,
          balance: "100.0000000",
        },
        {
          asset_type: "credit_alphanum4",
          asset_code: "MUSDC",
          asset_issuer: MUSDC_TESTNET_ISSUER,
          balance: "0.0000000",
        },
      ],
    }),
    { status: 200 }
  );
}

beforeEach(() => {
  useWalletStore.setState({
    publicKey: KEY,
    connected: true,
    network: "testnet",
  });
  useToastStore.setState({ toasts: [] });
  invalidateQueries.mockClear();
  setQueryData.mockClear();
  getQueryData.mockReset();
  getQueryData.mockImplementation(() => undefined);
  vi.clearAllMocks();
  // Stub fetch so both the proactive trustline check and hasBlendUsdcBalance
  // see USDC + mUSDC trustlines and a positive USDC balance, skipping the
  // add-trustline and testnet-faucet paths (those are covered in
  // useTrustlines.test.ts and useBlendFaucet.test.ts).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => bothTrustlinesHorizonResponse())
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVaultActions — deposit", () => {
  it("builds, signs, and submits a deposit successfully", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    expect(ok).toBe(true);
    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: "4.9750000",
      riskAcknowledged: true,
    });
    expect(wallet.sign).toHaveBeenCalledWith(
      "DEPOSIT_XDR",
      APP_NETWORK.passphrase
    );
    expect(api.submitTx).toHaveBeenCalledWith({ xdr: "SIGNED_XDR" });
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "success",
      message: "Deposited 10 USDC",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["vaults"] });
  });

  it("passes minSharesOut when specified", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        "9.5",
        true
      );
    });

    expect(ok).toBe(true);
    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: "9.5",
      riskAcknowledged: true,
    });
  });

  it("returns false without calling the API when risk has not been acknowledged", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(false);
    expect(api.buildDeposit).not.toHaveBeenCalled();
  });

  it("returns false without calling the API when no publicKey", async () => {
    useWalletStore.setState({
      publicKey: null,
      connected: false,
      network: "testnet",
    });
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit("10", "v", "USDC");
    });

    expect(ok).toBe(false);
    expect(api.buildDeposit).not.toHaveBeenCalled();
  });

  it("optimistically raises the cached position for the depositing vault", async () => {
    const cached = [
      { vaultId: "blend-usdc-fixed", shares: 100, deposited: 100 },
      { vaultId: "other-vault", shares: 7, deposited: 7 },
    ];
    getQueryData.mockReturnValueOnce(cached);

    const { result } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    const writes = positionWrites();
    expect(writes).toHaveLength(1);

    // Mirrors the withdraw flow: the cache entry is computed eagerly from the
    // pre-submit snapshot and written back as a value, not an updater fn.
    const [key, updated] = writes[0] as [unknown, typeof cached];
    expect(key).toEqual(["positions", KEY]);
    expect(updated[0]).toMatchObject({ shares: 110, deposited: 110 });
    // Unrelated positions are passed through untouched.
    expect(updated[1]).toBe(cached[1]);
  });

  it("converts the deposit through the implied share price when deposited differs from shares", async () => {
    // 100 shares backed by 120 USDC -> implied share price 1.2, so a 10 USDC
    // deposit mints 10 / 1.2 = 8.333… shares. A raw `shares + amount` (110)
    // or an inverted `amount * impliedSharePrice` (112) both fail this.
    const cached = [
      { vaultId: "blend-usdc-fixed", shares: 100, deposited: 120 },
    ];
    getQueryData.mockReturnValueOnce(cached);

    const { result } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    const [, updated] = positionWrites()[0] as [unknown, typeof cached];
    expect(updated[0].shares).toBeCloseTo(100 + 10 / 1.2, 10);
    expect(updated[0].shares).not.toBe(110);
    expect(updated[0].shares).not.toBe(112);
    expect(updated[0].deposited).toBe(130);
  });

  it("does not fabricate a position when none is cached yet", async () => {
    getQueryData.mockReturnValueOnce(undefined);

    const { result } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    expect(positionWrites()).toHaveLength(0);
  });
});

describe("useVaultActions — withdraw", () => {
  it("builds, signs, and submits a withdrawal successfully", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    expect(api.buildWithdraw).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: "8.9550000",
    });
    expect(wallet.sign).toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "success",
      message: "Withdrew 5 USDC",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["vaults"] });
  });

  it("passes minUsdcOut when specified", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw(
        "5",
        "blend-usdc-fixed",
        "USDC",
        "4.8"
      );
    });

    expect(ok).toBe(true);
    expect(api.buildWithdraw).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      shares: "5",
      min_usdc_out: "4.8",
    });
  });

  it("pushes an error toast and returns false when withdraw fails", async () => {
    vi.mocked(api.buildWithdraw).mockRejectedValueOnce(
      new Error("Insufficient shares")
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw("5", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(false);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "error" });
  });
});

describe("useVaultActions — fresh vault state slippage", () => {
  it("computes min_shares_out from live totalAssets/totalShares when omitted", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit(
        "25",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    expect(ok).toBe(true);
    expect(api.getVaultState).toHaveBeenCalled();
    // 25 * (50/100) * 0.995 = 12.4375
    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "25",
      min_shares_out: "12.4375000",
      riskAcknowledged: true,
    });
  });

  it("computes min_usdc_out from live vault state when omitted", async () => {
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    expect(api.getVaultState).toHaveBeenCalled();
    // 10 * (100/50) = 20 gross. No cached position, so the whole payout is
    // priced as gain: 20 - 10% fee = 18, then the 0.5% haircut -> 17.91.
    expect(api.buildWithdraw).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      shares: "10",
      min_usdc_out: "17.9100000",
    });
  });

  it("keeps an explicit minSharesOut override without re-fetching price math", async () => {
    const { result } = renderHook(() => useVaultActions());

    await act(async () => {
      await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        "9.5",
        true
      );
    });

    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "10",
      min_shares_out: "9.5",
      riskAcknowledged: true,
    });
  });

  it("prices min_usdc_out net of the performance fee using the position basis", async () => {
    // deposited is the position's current value and earned the yield above its
    // cost basis, so the basis is 40 - 6 = 34 over the position's 20 shares.
    getQueryData.mockImplementation((key: unknown[]) =>
      key[0] === "positions"
        ? [
            {
              vaultId: "blend-usdc-fixed",
              shares: 20,
              deposited: 40,
              earned: 6,
              entryTime: 0,
            },
          ]
        : undefined
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.withdraw("10", "blend-usdc-fixed", "USDC");
    });

    expect(ok).toBe(true);
    // 20 gross, 34 * 10/20 = 17 basis, 3 gain, 0.3 fee, 19.7 * 0.995 = 19.6015.
    expect(api.buildWithdraw).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      shares: "10",
      min_usdc_out: "19.6015000",
    });
  });

  it("falls back to the cached vault state when the fresh read fails", async () => {
    vi.mocked(api.getVaultState).mockRejectedValueOnce(
      new Error("rate limited")
    );
    getQueryData.mockImplementation((key: unknown[]) =>
      key[0] === "vault-state"
        ? {
            protocol: "blend",
            adapterId: "adapter",
            totalShares: 50,
            totalAssets: 100,
            paused: false,
          }
        : undefined
    );
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit(
        "25",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    expect(ok).toBe(true);
    expect(api.buildDeposit).toHaveBeenCalledWith({
      walletAddress: KEY,
      vaultId: "blend-usdc-fixed",
      amount: "25",
      min_shares_out: "12.4375000",
      riskAcknowledged: true,
    });
  });

  it("refuses to submit unprotected when no vault state is available at all", async () => {
    vi.mocked(api.getVaultState).mockRejectedValueOnce(new Error("rpc down"));
    const { result } = renderHook(() => useVaultActions());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.deposit(
        "10",
        "blend-usdc-fixed",
        "USDC",
        undefined,
        true
      );
    });

    expect(ok).toBe(false);
    expect(api.buildDeposit).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error",
      message: "Vault state unavailable",
    });
  });
});
