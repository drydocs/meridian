import { describe, expect, it } from "vitest";
import { FixedDecimal } from "./fixed";

describe("FixedDecimal", () => {
  it("round-trips on-chain scaled integers without loss", () => {
    const amount = FixedDecimal.fromScaled(123456789n);
    expect(FixedDecimal.fromString(amount.toString()).raw).toBe(amount.raw);
  });

  it("uses deterministic nearest rounding for division", () => {
    const value = FixedDecimal.fromString("1");
    expect(value.divide(FixedDecimal.fromString("3")).toString()).toBe("0.3333333");
  });

  it("supports exact add/subtract identity", () => {
    const value = FixedDecimal.fromString("42.125");
    const other = FixedDecimal.fromString("7.875");
    expect(value.add(other).subtract(other).raw).toBe(value.raw);
  });
});
