import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { USDC_ISSUER } from "@meridian/shared";
import {
  fetchSpendableBalance,
  useUsdcBalance,
} from "../../hooks/useUsdcBalance";
import { fetchBalances } from "../../lib/horizonAccount";
import { useWalletStore } from "../../store/wallet";

vi.mock("../../lib/horizonAccount", () => ({
  fetchBalances: vi.fn(),
}));

const TESTNET_ISSUER = USDC_ISSUER.testnet;

describe("fetchSpendableBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates spendable balance deducting selling liabilities", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: TESTNET_ISSUER,
          balance: "100.5000000",
          selling_liabilities: "20.5000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    const balance = await fetchSpendableBalance("GANYONE", "testnet");
    expect(balance).toBe(80);
  });

  it("clamps spendable balance to 0 if liabilities exceed balance", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: TESTNET_ISSUER,
          balance: "10.0000000",
          selling_liabilities: "25.0000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    const balance = await fetchSpendableBalance("GANYONE", "testnet");
    expect(balance).toBe(0);
  });

  it("returns 0 when account holds no USDC trustline", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "native",
          balance: "50.0000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    const balance = await fetchSpendableBalance("GANYONE", "testnet");
    expect(balance).toBe(0);
  });

  it("throws when Horizon fetch fails", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce(null);

    await expect(fetchSpendableBalance("GANYONE", "testnet")).rejects.toThrow(
      "Failed to fetch balance from Horizon"
    );
  });

  it("returns undefined when no USDC issuer is configured for the network", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: "GSOMEOTHERISSUER",
          balance: "100.0000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    const balance = await fetchSpendableBalance("GANYONE", "unknown");
    expect(balance).toBeUndefined();
  });
});

describe("useUsdcBalance hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWalletStore.setState({
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      network: "testnet",
      connected: true,
    });
  });

  it("returns undefined balance when no publicKey is present", async () => {
    useWalletStore.setState({ publicKey: null });
    const { result } = renderHook(() => useUsdcBalance());

    await waitFor(() => {
      expect(result.current.balance).toBeUndefined();
      expect(result.current.isError).toBe(false);
    });
  });

  it("returns spendable balance on successful fetch", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: TESTNET_ISSUER,
          balance: "50.0000000",
          selling_liabilities: "5.0000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    const { result } = renderHook(() => useUsdcBalance());

    await waitFor(() => {
      expect(result.current.balance).toBe(45);
      expect(result.current.isError).toBe(false);
    });
  });

  it("sets isError to true when fetch fails", async () => {
    vi.mocked(fetchBalances).mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useUsdcBalance());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
      expect(result.current.balance).toBeUndefined();
    });
  });

  it("refetches when refetch is called", async () => {
    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: TESTNET_ISSUER,
          balance: "50.0000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    const { result } = renderHook(() => useUsdcBalance());

    await waitFor(() => {
      expect(result.current.balance).toBe(50);
    });

    vi.mocked(fetchBalances).mockResolvedValueOnce({
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: TESTNET_ISSUER,
          balance: "75.0000000",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchBalances>>);

    result.current.refetch();

    await waitFor(() => {
      expect(result.current.balance).toBe(75);
    });
  });
});
