import { describe, expect, it } from "vitest";

import { Decimal, DEFAULT_DECIMAL_SCALE } from "./decimal";

describe("Decimal construction", () => {
  it("defaults to the Stellar stroop scale of 7", () => {
    expect(DEFAULT_DECIMAL_SCALE).toBe(7);
    expect(new Decimal(123n).scale).toBe(7);
    expect(new Decimal(123n, 4).scale).toBe(4);
    expect(new Decimal(123n).raw).toBe(123n);
  });

  it("rejects a negative or non-integer scale", () => {
    expect(() => new Decimal(1n, -1)).toThrowError(RangeError);
    expect(() => new Decimal(1n, 1.5)).toThrowError(RangeError);
  });

  it("creates from bigint units", () => {
    const d = Decimal.fromBigInt(123n);
    expect(d.raw).toBe(123n);
    expect(d.scale).toBe(7);
  });

  it("creates from stroops", () => {
    const d = Decimal.fromStroops(1_000_000_0n);
    expect(d.toString()).toBe("1.0000000");
  });

  it("creates zero and one", () => {
    expect(Decimal.zero().toString()).toBe("0.0000000");
    expect(Decimal.zero(2).toString()).toBe("0.00");
    expect(Decimal.one().toString()).toBe("1.0000000");
    expect(Decimal.one(2).raw).toBe(100n);
  });

  it("creates from every supported Decimal.from input", () => {
    const d = Decimal.fromString("1.5");
    expect(Decimal.from(d).toString()).toBe("1.5000000");
    expect(Decimal.from(15000000n).toString()).toBe("1.5000000");
    expect(Decimal.from(1.5).toString()).toBe("1.5000000");
    expect(Decimal.from("1.5").toString()).toBe("1.5000000");
    // Rescales a Decimal to the requested scale
    expect(Decimal.from(d, 2).toString()).toBe("1.50");
    expect(() => Decimal.from(true as unknown as string)).toThrowError(
      TypeError
    );
  });
});

describe("Decimal.fromString", () => {
  it("parses plain and signed decimal strings", () => {
    expect(Decimal.fromString("1.5").toString()).toBe("1.5000000");
    expect(Decimal.fromString("+1.5").toString()).toBe("1.5000000");
    expect(Decimal.fromString("-1.5").toString()).toBe("-1.5000000");
    expect(Decimal.fromString("42").toString()).toBe("42.0000000");
  });

  it("trims surrounding whitespace", () => {
    expect(Decimal.fromString("  1.5  ").toString()).toBe("1.5000000");
  });

  it("pads fractions shorter than the scale", () => {
    expect(Decimal.fromString("1.2", 4).toString()).toBe("1.2000");
  });

  it("rounds fractions longer than the scale half-up on the cut digit", () => {
    // 0.12345678 -> keep 7 dp (1234567), next digit 8 >= 5 -> round up
    expect(Decimal.fromString("0.12345678").toString()).toBe("0.1234568");
    // 0.12345671 -> next digit 1 < 5 -> truncate
    expect(Decimal.fromString("0.12345671").toString()).toBe("0.1234567");
  });

  it("rejects empty and malformed strings", () => {
    expect(() => Decimal.fromString("")).toThrowError(TypeError);
    expect(() => Decimal.fromString("   ")).toThrowError(TypeError);
    expect(() => Decimal.fromString("abc")).toThrowError(TypeError);
    expect(() => Decimal.fromString("1.2.3")).toThrowError(TypeError);
    expect(() => Decimal.fromString("1e5")).toThrowError(TypeError);
  });

  it("parses at custom scales", () => {
    expect(Decimal.fromString("1.25", 2).toString()).toBe("1.25");
    expect(Decimal.fromString("-1.25", 2).toString()).toBe("-1.25");
  });
});

describe("Decimal arithmetic", () => {
  it("adds numbers of mixed operand types", () => {
    expect(
      Decimal.fromString("1.5").add(Decimal.fromString("2.25")).toString()
    ).toBe("3.7500000");
    // bigint operands are raw unscaled units: 25000000n = 2.5 at scale 7
    expect(Decimal.fromString("1.5").add(25000000n).toString()).toBe(
      "4.0000000"
    );
    expect(Decimal.fromString("1.5").add("0.25").toString()).toBe("1.7500000");
  });

  it("subtracts across operand types", () => {
    expect(
      Decimal.fromString("2").sub(Decimal.fromString("0.5")).toString()
    ).toBe("1.5000000");
    // bigint operands are raw unscaled units: 15000000n = 1.5 at scale 7
    expect(Decimal.fromString("2").sub(15000000n).toString()).toBe("0.5000000");
    expect(Decimal.fromString("2").sub("0.25").toString()).toBe("1.7500000");
  });

  it("multiplies with half-up rounding at the scale", () => {
    // 1.5 * 1.5 = 2.25
    expect(
      Decimal.fromString("1.5").mul(Decimal.fromString("1.5")).toString()
    ).toBe("2.2500000");
    // 0.0000001 (parsed from 0.00000005, rounded up at the cut) * 2
    expect(
      Decimal.fromString("0.00000005").mul(Decimal.fromString("2")).toString()
    ).toBe("0.0000002");
  });

  it("divides with half-up rounding at the scale", () => {
    // 1 / 3 = 0.3333333 (truncates to 7 dp half-up)
    expect(
      Decimal.fromString("1").div(Decimal.fromString("3")).toString()
    ).toBe("0.3333333");
    // 2 / 3 = 0.6666667 (rounds up)
    expect(
      Decimal.fromString("2").div(Decimal.fromString("3")).toString()
    ).toBe("0.6666667");
  });

  it("rejects division by zero Decimal or bigint zero", () => {
    expect(() => Decimal.one().div(Decimal.zero())).toThrowError(RangeError);
    expect(() => Decimal.one().div(0n)).toThrowError(RangeError);
  });

  it("rejects unsupported operand types like numbers", () => {
    expect(() => Decimal.one().add(1.5 as unknown as string)).toThrowError(
      TypeError
    );
    expect(() => Decimal.one().mul(2 as unknown as string)).toThrowError(
      TypeError
    );
    expect(() => Decimal.one().eq(1.5 as unknown as string)).toThrowError(
      TypeError
    );
  });

  it("supports absolute value and negation", () => {
    expect(Decimal.fromString("-1.5").abs().toString()).toBe("1.5000000");
    expect(Decimal.fromString("1.5").abs().toString()).toBe("1.5000000");
    expect(Decimal.fromString("1.5").neg().toString()).toBe("-1.5000000");
    expect(Decimal.fromString("-1.5").neg().toString()).toBe("1.5000000");
  });

  it("accepts plain bigint and string operands", () => {
    // bigint operands are raw unscaled units: 30000000n = 3.0 at scale 7
    expect(Decimal.fromString("1").mul(30000000n).toString()).toBe("3.0000000");
    expect(Decimal.fromString("1").mul("3").toString()).toBe("3.0000000");
    expect(Decimal.fromString("1").div(20000000n).toString()).toBe("0.5000000");
    expect(Decimal.fromString("1").div("4").toString()).toBe("0.2500000");
  });
});

describe("Decimal rescale and rounding modes", () => {
  it("rescales up without loss", () => {
    expect(Decimal.fromString("1.5").rescale(9).toString()).toBe("1.500000000");
  });

  it("rescales down with each rounding mode", () => {
    const d = Decimal.fromString("1.5555555", 7);
    expect(d.rescale(0, "trunc").toString()).toBe("1");
    expect(d.rescale(0, "floor").toString()).toBe("1");
    expect(d.rescale(0, "ceil").toString()).toBe("2");
    expect(d.rescale(0, "half-up").toString()).toBe("2");
    expect(d.rescale(0, "half-even").toString()).toBe("2");
  });

  it("applies floor and ceil to negatives directionally", () => {
    const d = Decimal.fromString("-1.5", 7);
    expect(d.rescale(0, "floor").toString()).toBe("-2");
    expect(d.rescale(0, "ceil").toString()).toBe("-1");
    expect(d.rescale(0, "trunc").toString()).toBe("-1");
  });

  it("breaks half-even ties to the even quotient", () => {
    // 2.5 -> 2 (2 is even); 3.5 -> 4 (4 is even)
    expect(Decimal.fromString("2.5").rescale(0, "half-even").toString()).toBe(
      "2"
    );
    expect(Decimal.fromString("3.5").rescale(0, "half-even").toString()).toBe(
      "4"
    );
  });

  it("is a no-op at the same scale", () => {
    const d = Decimal.fromString("1.5");
    expect(d.rescale(7)).toBe(d);
  });

  it("rejects invalid decimal places in toFixed", () => {
    expect(() => Decimal.one().toFixed(-1)).toThrowError(RangeError);
    expect(() => Decimal.one().toFixed(1.5)).toThrowError(RangeError);
  });

  it("formats with toFixed", () => {
    expect(Decimal.fromString("1.2345678").toFixed(2)).toBe("1.23");
  });
});

describe("Decimal comparison and predicates", () => {
  it("compares across operand types", () => {
    const one = Decimal.one();
    expect(one.eq(Decimal.one())).toBe(true);
    // bigint operands are raw unscaled units: 10000000n = 1.0 at scale 7
    expect(one.eq(10000000n)).toBe(true);
    expect(one.eq("1")).toBe(true);
    expect(one.eq("1.0000001")).toBe(false);
    expect(one.eq(1n)).toBe(false);

    expect(one.gt(Decimal.zero())).toBe(true);
    expect(one.gte(Decimal.one())).toBe(true);
    expect(one.lt(Decimal.fromString("2"))).toBe(true);
    expect(one.lte(Decimal.one())).toBe(true);
  });

  it("reports zero, positive, and negative", () => {
    expect(Decimal.zero().isZero()).toBe(true);
    expect(Decimal.one().isZero()).toBe(false);
    expect(Decimal.one().isPositive()).toBe(true);
    expect(Decimal.fromString("-1").isNegative()).toBe(true);
  });

  it("converts to bigint raw and stroops", () => {
    expect(Decimal.fromString("1.5").toBigInt()).toBe(15000000n);
    expect(Decimal.fromString("1.5").toStroops()).toBe(15000000n);
    expect(Decimal.fromString("1.5", 2).toStroops()).toBe(15000000n);
  });

  it("renders trailing zeros in toString", () => {
    expect(Decimal.fromString("1.5").toString()).toBe("1.5000000");
    expect(Decimal.fromString("-0.5").toString()).toBe("-0.5000000");
    expect(Decimal.zero(0).toString()).toBe("0");
    expect(Decimal.fromString("-2", 0).toString()).toBe("-2");
  });
});
