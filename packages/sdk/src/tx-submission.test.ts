import { describe, it, expect } from "vitest";
import {
  keeperFeeForAttempt,
  keeperFeeConfig,
  maxFeeAttempt,
} from "../../stellar-sdk-helpers/src/keeper-tx";

describe("keeperFeeAttempt", () => {
  const { baseFee, multiplier, maxFee } = keeperFeeConfig;

  it("returns the base fee at attempt 0", () => {
    expect(keeperFeeForAttempt(0)).toBe(baseFee);
  });

  it("doubles once at attempt 1", () => {
    expect(keeperFeeForAttempt(1)).toBe(baseFee * multiplier);
  });

  it("applies the exponential curve before the cap", () => {
    const attempt = 2;
    const uncapped = baseFee * multiplier ** attempt;
    expect(uncapped).toBeLessThanOrEqual(maxFee);
    expect(keeperFeeForAttempt(attempt)).toBe(uncapped);
  });

  it("caps the fee at maxFee", () => {
    const attempt = maxFeeAttempt + 1;
    expect(baseFee * multiplier ** attempt).toBeGreaterThan(maxFee);
    expect(keeperFeeForAttempt(attempt)).toBe(maxFee);
  });

  it("never exceeds the cap for large attempt counts", () => {
    expect(keeperFeeForAttempt(100)).toBe(maxFee);
  });
});

describe("keeperFeeConfig", () => {
  it("exposes a consistent fee curve configuration", () => {
    expect(keeperFeeConfig.baseFee).toBeGreaterThan(0);
    expect(keeperFeeConfig.multiplier).toBeGreaterThan(1);
    expect(keeperFeeConfig.maxFee).toBeGreaterThan(keeperFeeConfig.baseFee);
  });

  it("derives maxFeeAttempt from the configured curve", () => {
    const { baseFee, multiplier, maxFee } = keeperFeeConfig;
    const expected = Math.ceil(
      Math.log(maxFee / baseFee) / Math.log(multiplier),
    );
    expect(maxFeeAttempt).toBe(expected);
  });
});
