import { describe, it, expect } from "vitest";
import {
  computeMinSharesOut,
  computeMinUsdcOut,
} from "../../hooks/useVaultState";

describe("computeMinSharesOut / computeMinUsdcOut", () => {
  it("applies the default 50 bps haircut to deposit shares", () => {
    // amount 25, share price 2.0 (100 assets / 50 shares) -> 12.5 * 0.995
    expect(computeMinSharesOut(25, 100, 50)).toBe("12.4375000");
  });

  it("charges no fee while the payout is at or below the cost basis", () => {
    // 10 shares at 2.0 = 20, all of it basis, so only the haircut applies.
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 50,
        principal: 20,
        positionShares: 10,
      })
    ).toBe("19.9000000");
  });

  it("prices the floor net of the 10% fee on the gain", () => {
    // 20 gross, 34 * 10/20 = 17 of it basis, 3 gain, 0.3 fee -> 19.7 * 0.995
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 50,
        principal: 34,
        positionShares: 20,
      })
    ).toBe("19.6015000");
  });

  it("treats an unknown cost basis as entirely gain", () => {
    // 20 gross, no basis to offset it, 2 fee -> 18 * 0.995
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 50,
        principal: 0,
        positionShares: 0,
      })
    ).toBe("17.9100000");
  });

  it("returns undefined when the vault has no shares yet", () => {
    expect(computeMinSharesOut(10, 0, 0)).toBeUndefined();
    expect(
      computeMinUsdcOut({
        shares: 10,
        totalAssets: 100,
        totalShares: 0,
        principal: 0,
        positionShares: 0,
      })
    ).toBeUndefined();
  });
});
