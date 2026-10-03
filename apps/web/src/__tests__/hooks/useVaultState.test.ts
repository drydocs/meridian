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

  it("applies the default 50 bps haircut to withdraw USDC", () => {
    expect(computeMinUsdcOut(10, 100, 50)).toBe("19.9000000");
  });

  it("returns undefined when the vault has no shares yet", () => {
    expect(computeMinSharesOut(10, 0, 0)).toBeUndefined();
    expect(computeMinUsdcOut(10, 100, 0)).toBeUndefined();
  });
});
