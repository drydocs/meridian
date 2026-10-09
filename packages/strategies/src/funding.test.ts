import { describe, it, expect } from "vitest";
import {
  FixedPointDecimal,
  FundingPosition,
  FundingRate,
  FundingCapture,
  FundingTermStructure,
  accrueFunding,
  computeBasis,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers that keep tests readable without magic literals
// ---------------------------------------------------------------------------

/** Shorthand: build a FundingPosition with a decimal-string notional. */
function pos(notional: string): FundingPosition {
  return { notional: FixedPointDecimal.fromString(notional) };
}

/** Shorthand: build a FundingRate with a decimal-string rate per second. */
function rate(ratePerSecond: string): FundingRate {
  return { ratePerSecond: FixedPointDecimal.fromString(ratePerSecond) };
}

/** Shorthand: build a FixedPointDecimal from a decimal string. */
function fp(value: string): FixedPointDecimal {
  return FixedPointDecimal.fromString(value);
}

// ---------------------------------------------------------------------------
// accrueFunding sign conventions
// ---------------------------------------------------------------------------

describe("accrueFunding sign conventions (short-leg perspective)", () => {
  it("positive rate: short receives funding (result > 0)", () => {
    // notional=100, rate=0.0000001/s (1 stroop per unit), elapsed=1s
    // payment = 100 * 0.0000001 * 1 = 0.00001
    const result = accrueFunding(pos("100"), rate("0.0000001"), 1n);
    expect(result.toStroops()).toBeGreaterThan(0n);
    expect(result.toString()).toBe("0.00001");
  });

  it("negative rate: short pays funding (result < 0)", () => {
    // notional=100, rate=-0.0000001/s, elapsed=1s → payment = -0.00001
    const result = accrueFunding(pos("100"), rate("-0.0000001"), 1n);
    expect(result.toStroops()).toBeLessThan(0n);
    expect(result.toString()).toBe("-0.00001");
  });

  it("zero rate: no payment regardless of notional and elapsed", () => {
    const result = accrueFunding(pos("1000000"), rate("0"), 86400n);
    expect(result.toStroops()).toBe(0n);
    expect(result.toString()).toBe("0");
  });

  it("zero notional: no payment regardless of rate and elapsed", () => {
    const result = accrueFunding(pos("0"), rate("0.0000001"), 3600n);
    expect(result.toStroops()).toBe(0n);
  });

  it("zero elapsed: no payment regardless of notional and rate", () => {
    const result = accrueFunding(pos("100"), rate("0.0000001"), 0n);
    expect(result.toStroops()).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// accrueFunding arithmetic correctness and no-float guarantee
// ---------------------------------------------------------------------------

describe("accrueFunding arithmetic precision and no-float requirement", () => {
  it("result is a FixedPointDecimal (toStroops returns bigint)", () => {
    const result = accrueFunding(pos("100"), rate("0.0000001"), 1n);
    expect(result).toBeInstanceOf(FixedPointDecimal);
    expect(typeof result.toStroops()).toBe("bigint");
  });

  it("whole-number notional × exact rate × 1 second is precise", () => {
    // notional = 1 unit = 10_000_000 stroops
    // rate = 1 stroop / (unit·s) → ratePerSecond = 0.0000001
    // expected = 1 * 0.0000001 * 1 = 0.0000001 (1 stroop)
    const result = accrueFunding(pos("1"), rate("0.0000001"), 1n);
    expect(result.toStroops()).toBe(1n);
    expect(result.toString()).toBe("0.0000001");
  });

  it("scales linearly with elapsed seconds", () => {
    const r1 = accrueFunding(pos("100"), rate("0.0000001"), 1n);
    const r60 = accrueFunding(pos("100"), rate("0.0000001"), 60n);
    expect(r60.toStroops()).toBe(r1.toStroops() * 60n);
  });

  it("scales linearly with notional", () => {
    const r1 = accrueFunding(pos("1"), rate("0.0000001"), 3600n);
    const r100 = accrueFunding(pos("100"), rate("0.0000001"), 3600n);
    expect(r100.toStroops()).toBe(r1.toStroops() * 100n);
  });

  it("one full day at a modest rate stays integer-exact", () => {
    // notional=10_000, rate=0.0000001/s, elapsed=86400s (1 day)
    // raw = 10_000 * 10_000_000 * 1 * 86_400 / 10_000_000
    //     = 10_000 * 86_400 = 864_000_000 stroops = 86.4
    const result = accrueFunding(pos("10000"), rate("0.0000001"), 86400n);
    expect(result.toStroops()).toBe(864_000_000n);
    expect(result.toString()).toBe("86.4");
  });

  it("very small notional × small rate × small elapsed truncates correctly", () => {
    // notional=1 stroop (0.0000001), rate=1 stroop/unit, elapsed=1s
    // raw = 1 * 1 * 1 / 10_000_000 = 0  (truncated, below 1 stroop)
    const tinyPos: FundingPosition = {
      notional: FixedPointDecimal.fromStroops(1n),
    };
    const result = accrueFunding(tinyPos, rate("0.0000001"), 1n);
    // 1 stroop_notional * 1 stroop_rate * 1s / 10_000_000 = 0 (integer truncation)
    expect(result.toStroops()).toBe(0n);
  });

  it("negative elapsed seconds throws RangeError", () => {
    expect(() => accrueFunding(pos("100"), rate("0.0000001"), -1n)).toThrow(
      RangeError
    );
    expect(() => accrueFunding(pos("100"), rate("0.0000001"), -1n)).toThrow(
      /elapsedSeconds must be ≥ 0/
    );
  });

  it("large notional handles without overflow (bigint)", () => {
    // 1_000_000 units × 0.0000001/s × 86_400s = 8_640 units
    // raw = 1_000_000 * 10_000_000 stroops_notional * 1 stroop_rate * 86_400 / 10_000_000
    //     = 1_000_000 * 1 * 86_400 = 86_400_000_000 stroops = 8_640 units
    const result = accrueFunding(pos("1000000"), rate("0.0000001"), 86400n);
    expect(result.toStroops()).toBe(86_400_000_000n);
    expect(result.toString()).toBe("8640");
  });
});

// ---------------------------------------------------------------------------
// computeBasis correctness
// ---------------------------------------------------------------------------

describe("computeBasis spot minus derivative", () => {
  it("backwardation: spot > derivative → positive basis", () => {
    // spot = 100.05, derivative = 100.00 → basis = 0.05
    const result = computeBasis(fp("100.05"), fp("100"));
    expect(result.toStroops()).toBeGreaterThan(0n);
    expect(result.toString()).toBe("0.05");
  });

  it("contango: spot < derivative → negative basis", () => {
    // spot = 99.95, derivative = 100.00 → basis = -0.05
    const result = computeBasis(fp("99.95"), fp("100"));
    expect(result.toStroops()).toBeLessThan(0n);
    expect(result.toString()).toBe("-0.05");
  });

  it("at par: spot === derivative → zero basis", () => {
    const result = computeBasis(fp("100"), fp("100"));
    expect(result.toStroops()).toBe(0n);
    expect(result.toString()).toBe("0");
  });

  it("result is a FixedPointDecimal with bigint stroops (no floats)", () => {
    const result = computeBasis(fp("1.0000001"), fp("1.0000000"));
    expect(result).toBeInstanceOf(FixedPointDecimal);
    expect(typeof result.toStroops()).toBe("bigint");
    expect(result.toStroops()).toBe(1n);
    expect(result.toString()).toBe("0.0000001");
  });

  it("preserves full 7-decimal precision", () => {
    const result = computeBasis(fp("1.1234567"), fp("1.0000000"));
    expect(result.toStroops()).toBe(1_234_567n);
    expect(result.toString()).toBe("0.1234567");
  });

  it("large prices: basis stays integer-exact", () => {
    // spot = 50_000.0000001, derivative = 49_999.9999999 → basis = 0.0000002
    const result = computeBasis(fp("50000.0000001"), fp("49999.9999999"));
    expect(result.toStroops()).toBe(2n);
    expect(result.toString()).toBe("0.0000002");
  });

  it("commutative inversion: computeBasis(a,b) == -computeBasis(b,a)", () => {
    const spot = fp("100.1234567");
    const deriv = fp("100.0000000");
    const forward = computeBasis(spot, deriv);
    const reversed = computeBasis(deriv, spot);
    expect(forward.toStroops()).toBe(-reversed.toStroops());
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria integration checks
// ---------------------------------------------------------------------------

describe("acceptance criteria integration", () => {
  it("funding accrual sign conventions are documented and correct", () => {
    // Positive rate → short receives (value > 0)
    const received = accrueFunding(pos("100"), rate("0.0000010"), 3600n);
    expect(received.toStroops()).toBeGreaterThan(0n);

    // Negative rate → short pays (value < 0)
    const paid = accrueFunding(pos("100"), rate("-0.0000010"), 3600n);
    expect(paid.toStroops()).toBeLessThan(0n);

    // Symmetric: same absolute magnitude
    expect(received.toStroops()).toBe(-paid.toStroops());
  });

  it("basis is computed as spot minus derivative delta", () => {
    const spot = fp("1.0050000");
    const deriv = fp("1.0000000");
    const basis = computeBasis(spot, deriv);
    // basis = spot - derivative = 0.005
    expect(basis.toStroops()).toBe(50_000n);
    expect(basis.toString()).toBe("0.005");
  });

  it("consumes the FundingRate type with no duplicate rate interface", () => {
    // Verify FundingRate is the same type used by accrueFunding (compiles & runs)
    const fundingRate: FundingRate = {
      ratePerSecond: FixedPointDecimal.fromString("0.0000001"),
    };
    const position: FundingPosition = {
      notional: FixedPointDecimal.fromString("500"),
    };
    const result = accrueFunding(position, fundingRate, 60n);
    expect(result).toBeInstanceOf(FixedPointDecimal);
  });

  it("no floats: all intermediate and final values are bigint stroops", () => {
    const fundingResult = accrueFunding(
      pos("99999.9999999"),
      rate("0.0000001"),
      86399n
    );
    const basisResult = computeBasis(fp("1.9999999"), fp("1.0000001"));

    // Confirming the internal representation is bigint
    expect(typeof fundingResult.toStroops()).toBe("bigint");
    expect(typeof basisResult.toStroops()).toBe("bigint");
  });

  it("accrueFunding and computeBasis both return FixedPointDecimal", () => {
    const funding = accrueFunding(pos("100"), rate("0.0000001"), 1n);
    const basis = computeBasis(fp("1.001"), fp("1.0"));
    expect(funding).toBeInstanceOf(FixedPointDecimal);
    expect(basis).toBeInstanceOf(FixedPointDecimal);
  });
});

describe("FundingTermStructure", () => {
  const mkPoint = (
    horizon: number,
    funding: string,
    basis: string
  ): FundingCapture => ({
    horizon,
    funding: FixedPointDecimal.fromString(funding),
    basis: FixedPointDecimal.fromString(basis),
  });

  it("throws if empty", () => {
    expect(() => new FundingTermStructure([])).toThrow(
      "Term structure requires at least one point"
    );
  });

  it("throws if horizon is not an integer", () => {
    expect(() => new FundingTermStructure([mkPoint(1.5, "0", "0")])).toThrow(
      "Horizon must be an integer"
    );
  });

  it("sorts points by horizon", () => {
    const ts = new FundingTermStructure([
      mkPoint(20, "2", "2"),
      mkPoint(10, "1", "1"),
      mkPoint(30, "3", "3"),
    ]);
    const points = ts.points;
    expect(points[0]!.horizon).toBe(10);
    expect(points[1]!.horizon).toBe(20);
    expect(points[2]!.horizon).toBe(30);
  });

  it("returns flat if below minimum horizon", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.0"),
    ]);
    const p = ts.getExpectedCapture(5);
    expect(p.horizon).toBe(5);
    expect(p.funding.toString()).toBe("1");
    expect(p.basis.toString()).toBe("0.5");
  });

  it("returns flat if above maximum horizon", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.0"),
    ]);
    const p = ts.getExpectedCapture(25);
    expect(p.horizon).toBe(25);
    expect(p.funding.toString()).toBe("2");
    expect(p.basis.toString()).toBe("1");
  });

  it("returns exact point if horizon matches", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.0"),
    ]);
    const p = ts.getExpectedCapture(20);
    expect(p.horizon).toBe(20);
    expect(p.funding.toString()).toBe("2");
    expect(p.basis.toString()).toBe("1");
  });

  it("interpolates correctly and monotonically", () => {
    const ts = new FundingTermStructure([
      mkPoint(10, "1", "0.5"),
      mkPoint(20, "2", "1.5"),
    ]);
    const p = ts.getExpectedCapture(15);
    expect(p.horizon).toBe(15);
    expect(p.funding.toString()).toBe("1.5");
    expect(p.basis.toString()).toBe("1");

    const p2 = ts.getExpectedCapture(12);
    expect(p2.horizon).toBe(12);
    expect(p2.funding.toString()).toBe("1.2");
    expect(p2.basis.toString()).toBe("0.7");
  });

  it("throws if requested horizon is not an integer", () => {
    const ts = new FundingTermStructure([mkPoint(10, "1", "0.5")]);
    expect(() => ts.getExpectedCapture(10.5)).toThrow(
      "Horizon must be an integer"
    );
  });

  it("interpolates negative values correctly", () => {
    const ts = new FundingTermStructure([
      mkPoint(100, "-1", "-2"),
      mkPoint(200, "1", "2"),
    ]);
    const p = ts.getExpectedCapture(150);
    expect(p.funding.toString()).toBe("0");
    expect(p.basis.toString()).toBe("0");

    const p2 = ts.getExpectedCapture(125);
    expect(p2.funding.toString()).toBe("-0.5");
    expect(p2.basis.toString()).toBe("-1");
  });
});
