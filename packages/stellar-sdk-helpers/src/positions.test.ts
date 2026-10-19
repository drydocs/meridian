import { describe, it, expect } from "vitest";
import { computePosition } from "./positions";

const VAULT = "CVAULT";

describe("computePosition", () => {
  it("returns no position when the address holds zero shares", () => {
    expect(
      computePosition(VAULT, {
        shares: 0n,
        totalShares: 0n,
        totalAssets: 0n,
        principal: 0n,
        entryTime: 0n,
      })
    ).toEqual([]);
  });

  it("reports zero earned for a fresh deposit with no yield", () => {
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 100_0000000n,
      principal: 100_0000000n,
      entryTime: 1_700_000_000n,
    });
    expect(p).toBeDefined();
    expect(p!.vaultId).toBe(VAULT);
    expect(p!.shares).toBe(100);
    expect(p!.deposited).toBe(100);
    expect(p!.earned).toBe(0);
    expect(p!.entryTime).toBe(1_700_000_000);
  });

  it("derives earned as current share value minus principal", () => {
    // The sole depositor's 100 shares own the whole 110 USDC pool; basis was
    // 100 USDC, so earned is 10.
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 110_0000000n,
      principal: 100_0000000n,
      entryTime: 0n,
    });
    expect(p).toBeDefined();
    expect(p!.deposited).toBe(110);
    expect(p!.earned).toBe(10);
  });

  it("falls back to zero earned when principal is unknown (pre-upgrade contract)", () => {
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 110_0000000n,
      principal: null,
      entryTime: 0n,
    });
    expect(p).toBeDefined();
    expect(p!.deposited).toBe(110);
    expect(p!.earned).toBe(0);
  });

  it("never reports negative earned if the share value dips below basis", () => {
    const [p] = computePosition(VAULT, {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 90_0000000n,
      principal: 100_0000000n,
      entryTime: 0n,
    });
    expect(p).toBeDefined();
    expect(p!.earned).toBe(0);
  });
});

describe("computePosition with no recorded cost basis", () => {
  it("reports no yield for a position that arrived by mUSDC transfer", () => {
    // The vault has no basis recorded for a holder whose shares were
    // transferred to them (#504): mUSDC is a Stellar Asset Contract, so the
    // vault never sees the transfer. Treating that missing basis as a basis
    // of zero would show the new holder their entire balance as profit.
    const [position] = computePosition("meridian-usdc", {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 120_0000000n,
      principal: 0n,
      entryTime: 0n,
    });

    expect(position?.deposited).toBe(120);
    expect(position?.earned).toBe(0);
  });

  it("still reports yield for a depositor whose basis is recorded", () => {
    const [position] = computePosition("meridian-usdc", {
      shares: 100_0000000n,
      totalShares: 100_0000000n,
      totalAssets: 120_0000000n,
      principal: 100_0000000n,
      entryTime: 1n,
    });

    expect(position?.earned).toBe(20);
  });
});

describe("computePosition matches the vault withdrawal payout", () => {
  // The vault burns adapter shares as `shares * total_assets / total_shares`
  // with no virtual offset (see vault/src/lib.rs withdraw), so the helper
  // must report the same value. This pins the formula against a known state.
  it("converts shares to assets with the raw ratio", () => {
    // 300 shares of 1,000 total own 300 of 1,200 assets.
    const [position] = computePosition(VAULT, {
      shares: 300_0000000n,
      totalShares: 1_000_0000000n,
      totalAssets: 1_200_0000000n,
      principal: 300_0000000n,
      entryTime: 0n,
    });
    // 300 * 1200 / 1000 = 360, exactly the withdrawal payout.
    expect(position?.deposited).toBe(360);
    expect(position?.earned).toBe(60);
  });

  it("rounds down and matches the withdrawal payout when totalAssets < totalShares", () => {
    // A loss puts totalAssets below totalShares. The contract divides with
    // integer truncation, so the helper must truncate too and never round
    // up past the payout.
    // 300 * 500 / 1000 = 150 exactly.
    const [exact] = computePosition(VAULT, {
      shares: 300_0000000n,
      totalShares: 1_000_0000000n,
      totalAssets: 500_0000000n,
      principal: 300_0000000n,
      entryTime: 0n,
    });
    expect(exact?.deposited).toBe(150);
    expect(exact?.earned).toBe(0);

    // 333 * 500 / 1000 = 166.5 → truncates to 166, the contract's payout.
    const [rounded] = computePosition(VAULT, {
      shares: 333_0000000n,
      totalShares: 1_000_0000000n,
      totalAssets: 500_0000000n,
      principal: 333_0000000n,
      entryTime: 0n,
    });
    expect(rounded?.deposited).toBe(166);
  });
});
