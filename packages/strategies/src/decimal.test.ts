import { describe, it, expect } from "vitest";
import { Decimal, DEFAULT_DECIMAL_SCALE } from "./decimal";

describe("Decimal fixed-point money math", () => {
  describe("Instantiation and conversions", () => {
    it("creates Decimal from stroops / bigint", () => {
      expect(DEFAULT_DECIMAL_SCALE).toBe(7);
      const d = Decimal.fromStroops(10000000n); // 1.0000000 (scale 7)
      expect(d.raw).toBe(10000000n);
      expect(d.scale).toBe(DEFAULT_DECIMAL_SCALE);
      expect(d.toString()).toBe("1.0000000");
      expect(d.toBigInt()).toBe(10000000n);
      expect(d.toStroops()).toBe(10000000n);
    });

    it("creates Decimal from human readable string", () => {
      const d1 = Decimal.fromString("123.4567891");
      expect(d1.raw).toBe(1234567891n);
      expect(d1.toString()).toBe("123.4567891");

      const d2 = Decimal.fromString("-45.5");
      expect(d2.raw).toBe(-455000000n);
      expect(d2.toString()).toBe("-45.5000000");

      const d3 = Decimal.fromString("0.0000001");
      expect(d3.raw).toBe(1n);
    });

    it("supports zero and one factories", () => {
      const zero = Decimal.zero();
      expect(zero.isZero()).toBe(true);
      expect(zero.raw).toBe(0n);

      const one = Decimal.one();
      expect(one.raw).toBe(10000000n);
      expect(one.toString()).toBe("1.0000000");
    });

    it("preserves exact on-chain integer round-trip", () => {
      const onChainAmount = 9876543210123n;
      const dec = Decimal.fromBigInt(onChainAmount);
      expect(dec.toBigInt()).toBe(onChainAmount);
      expect(dec.toStroops()).toBe(onChainAmount);
    });

    it("throws on invalid string format", () => {
      expect(() => Decimal.fromString("")).toThrow(TypeError);
      expect(() => Decimal.fromString("abc")).toThrow(TypeError);
      expect(() => Decimal.fromString("12.34.56")).toThrow(TypeError);
    });
  });

  describe("Arithmetic operations", () => {
    it("adds and subtracts without precision loss", () => {
      const a = Decimal.fromString("100.2500000");
      const b = Decimal.fromString("50.7500000");

      const sum = a.add(b);
      expect(sum.toString()).toBe("151.0000000");

      const diff = a.sub(b);
      expect(diff.toString()).toBe("49.5000000");
    });

    it("multiplies with rounding", () => {
      // 10.0000000 * 2.5000000 = 25.0000000
      const a = Decimal.fromString("10.0000000");
      const b = Decimal.fromString("2.5000000");
      const product = a.mul(b);
      expect(product.toString()).toBe("25.0000000");

      // 1.0000003 * 1.0000003 = 1.00000060000009 -> rounded to 1.0000006
      const c = Decimal.fromString("1.0000003");
      const d = Decimal.fromString("1.0000003");
      expect(c.mul(d).toString()).toBe("1.0000006");
    });

    it("divides with deterministic rounding", () => {
      const ten = Decimal.fromString("10.0000000");
      const three = Decimal.fromString("3.0000000");

      // 10 / 3 = 3.3333333333... -> 3.3333333 (half-up)
      const resHalfUp = ten.div(three, "half-up");
      expect(resHalfUp.toString()).toBe("3.3333333");

      // 1 / 2 = 0.5000000
      const one = Decimal.one();
      const two = Decimal.fromString("2.0000000");
      expect(one.div(two).toString()).toBe("0.5000000");
    });

    it("throws on division by zero", () => {
      const a = Decimal.one();
      const zero = Decimal.zero();
      expect(() => a.div(zero)).toThrow(RangeError);
      expect(() => a.div(0n)).toThrow(RangeError);
    });

    it("supports negation and absolute value", () => {
      const a = Decimal.fromString("12.3456789");
      expect(a.neg().toString()).toBe("-12.3456789");
      expect(a.neg().abs().toString()).toBe("12.3456789");
      expect(a.abs().toString()).toBe("12.3456789");
      expect(a.isPositive()).toBe(true);
      expect(a.neg().isNegative()).toBe(true);
    });
  });

  describe("Rounding modes", () => {
    it("handles ceil, floor, trunc, half-up, and half-even properly", () => {
      // 1 / 3 = 0.3333333333333333... at scale 1
      const one = Decimal.fromBigInt(10n, 1); // 1.0
      const three = Decimal.fromBigInt(30n, 1); // 3.0

      // 10 * 10 / 30 = 3.33333333...
      // trunc -> 3 (0.3)
      expect(one.div(three, "trunc").raw).toBe(3n);
      // floor -> 3 (0.3)
      expect(one.div(three, "floor").raw).toBe(3n);
      // ceil -> 4 (0.4)
      expect(one.div(three, "ceil").raw).toBe(4n);

      // Negative division: -1 / 3 = -0.33333...
      const negOne = Decimal.fromBigInt(-10n, 1);
      expect(negOne.div(three, "trunc").raw).toBe(-3n);
      expect(negOne.div(three, "floor").raw).toBe(-4n);
      expect(negOne.div(three, "ceil").raw).toBe(-3n);

      // Half-even test (banker's rounding)
      // 1.5 -> 2 (even), 2.5 -> 2 (even), 3.5 -> 4 (even)
      const d1_5 = Decimal.fromBigInt(15n, 1);
      const d2_5 = Decimal.fromBigInt(25n, 1);
      const d3_5 = Decimal.fromBigInt(35n, 1);
      expect(d1_5.rescale(0, "half-even").raw).toBe(2n);
      expect(d2_5.rescale(0, "half-even").raw).toBe(2n);
      expect(d3_5.rescale(0, "half-even").raw).toBe(4n);

      // Non-tie cases round to the nearest integer in both directions
      expect(Decimal.fromBigInt(17n, 1).rescale(0, "half-even").raw).toBe(2n);
      expect(Decimal.fromBigInt(12n, 1).rescale(0, "half-even").raw).toBe(1n);
      expect(Decimal.fromBigInt(-17n, 1).rescale(0, "half-even").raw).toBe(-2n);

      // Ties on a negative quotient round toward the even neighbour
      expect(Decimal.fromBigInt(-15n, 1).rescale(0, "half-even").raw).toBe(-2n);
      expect(Decimal.fromBigInt(-25n, 1).rescale(0, "half-even").raw).toBe(-2n);
    });

    it("handles a negative divisor", () => {
      const one = Decimal.fromBigInt(10n, 1); // 1.0
      const negativeThree = Decimal.fromBigInt(-30n, 1); // -3.0

      expect(one.div(negativeThree).toString()).toBe("-0.3");
      expect(one.div(negativeThree, "floor").toString()).toBe("-0.4");
      expect(one.div(Decimal.fromBigInt(-20n, 1)).toString()).toBe("-0.5");
    });
  });

  describe("Comparisons", () => {
    it("correctly compares Decimals", () => {
      const a = Decimal.fromString("10.5000000");
      const b = Decimal.fromString("10.5000000");
      const c = Decimal.fromString("20.0000000");
      const d = Decimal.fromString("5.0000000");

      expect(a.eq(b)).toBe(true);
      expect(a.eq(c)).toBe(false);
      expect(a.lt(c)).toBe(true);
      expect(a.lte(b)).toBe(true);
      expect(a.gt(d)).toBe(true);
      expect(a.gte(b)).toBe(true);
    });
  });

  describe("Property-based test", () => {
    it("(a + b) - b === a holds across random values", () => {
      // Test 100 random combinations
      for (let i = 0; i < 100; i++) {
        const rawA = BigInt(
          Math.floor(Math.random() * 1000000000000) - 500000000000
        );
        const rawB = BigInt(
          Math.floor(Math.random() * 1000000000000) - 500000000000
        );

        const a = Decimal.fromBigInt(rawA);
        const b = Decimal.fromBigInt(rawB);

        const result = a.add(b).sub(b);
        expect(result.raw).toBe(a.raw);
        expect(result.eq(a)).toBe(true);
      }
    });

    it("(a + b) - b === a holds when the operands have different scales", () => {
      for (let i = 0; i < 100; i++) {
        const rawA = BigInt(Math.floor(Math.random() * 1_000_000));
        const rawB = BigInt(Math.floor(Math.random() * 1_000_000));
        const scaleA = Math.floor(Math.random() * 10);
        const scaleB = Math.floor(Math.random() * 10);

        const a = Decimal.fromBigInt(rawA, scaleA);
        const b = Decimal.fromBigInt(rawB, scaleB);

        expect(a.add(b).sub(b).eq(a)).toBe(true);
        expect(a.add(b).sub(a).eq(b)).toBe(true);
      }
    });
  });

  describe("Mixed-scale operands", () => {
    it("aligns to the wider scale instead of rounding an operand down", () => {
      const ten = Decimal.fromBigInt(10n, 0); // 10
      const oneAndAHalf = Decimal.fromBigInt(15n, 1); // 1.5

      expect(ten.add(oneAndAHalf).toString()).toBe("11.5");
      expect(ten.sub(oneAndAHalf).toString()).toBe("8.5");
      expect(ten.mul(oneAndAHalf).toString()).toBe("15.0");
      expect(ten.div(oneAndAHalf).toString()).toBe("6.7");
    });

    it("divides by a non-zero operand finer than the receiver scale", () => {
      const one = Decimal.fromBigInt(1n, 0); // 1
      const fourTenths = Decimal.fromBigInt(4n, 1); // 0.4
      expect(one.div(fourTenths).toString()).toBe("2.5");

      const tiny = Decimal.fromBigInt(1n, 8); // 1e-8
      expect(one.div(tiny).toString()).toBe("100000000.00000000");
    });

    it("keeps addition exact when the receiver has the narrower scale", () => {
      const sum = Decimal.fromBigInt(201n, 0).add(Decimal.fromBigInt(-195n, 1));
      expect(sum.toString()).toBe("181.5");

      const tiny = Decimal.fromBigInt(1n, 8); // 1e-8
      expect(Decimal.zero().add(tiny).toString()).toBe("0.00000001");
    });

    it("compares across scales symmetrically", () => {
      const tiny = Decimal.fromBigInt(1n, 8); // 1e-8
      const zero = Decimal.zero(); // 0 at scale 7

      expect(zero.eq(tiny)).toBe(false);
      expect(tiny.eq(zero)).toBe(false);
      expect(tiny.gt(zero)).toBe(true);
      expect(zero.lt(tiny)).toBe(true);
      expect(zero.gte(tiny)).toBe(false);
      expect(zero.lte(tiny)).toBe(true);
    });

    it("orders values that would collapse onto the same coarser scale", () => {
      const a = Decimal.fromBigInt(15n, 8); // 1.5e-7
      const b = Decimal.fromBigInt(1n, 7); // 1e-7

      expect(a.gt(b)).toBe(true);
      expect(b.gt(a)).toBe(false);
      expect(b.lt(a)).toBe(true);
      expect(a.eq(b)).toBe(false);
    });

    it("treats a bigint operand as units at the receiver scale", () => {
      expect(Decimal.fromStroops(10_000_000n).add(1n).toString()).toBe(
        "1.0000001"
      );
      expect(Decimal.fromBigInt(10n, 0).add(5n).toString()).toBe("15");
    });

    it("takes a string operand at its exact value", () => {
      const whole = Decimal.fromBigInt(10n, 0);
      expect(whole.add("1.5").toString()).toBe("11.5");
      expect(whole.mul("1.5").toString()).toBe("15.0");
      expect(whole.div("1.5").toString()).toBe("6.7");
    });

    it("rejects a number operand", () => {
      const d = Decimal.one();
      expect(() => d.add(1 as unknown as bigint)).toThrow(TypeError);
      expect(() => d.eq(1 as unknown as bigint)).toThrow(TypeError);
    });

    it("rejects a malformed string operand", () => {
      const d = Decimal.one();
      expect(() => d.add("abc")).toThrow(TypeError);
      expect(() => d.add("1.2.3")).toThrow(TypeError);
    });
  });

  describe("String parsing edges", () => {
    it("rounds excess fractional digits half-up", () => {
      expect(Decimal.fromString("1.23456784").raw).toBe(12345678n);
      expect(Decimal.fromString("1.23456785").raw).toBe(12345679n);
      expect(Decimal.fromString("1.99999999").toString()).toBe("2.0000000");
    });

    it("accepts a leading sign and surrounding whitespace", () => {
      expect(Decimal.fromString("  +1.5  ").raw).toBe(15000000n);
      expect(Decimal.fromString("-0.5").raw).toBe(-5000000n);
    });

    it("parses at a non-default scale", () => {
      expect(Decimal.fromString("42", 0).toString()).toBe("42");
      expect(Decimal.fromString("1.25", 2).raw).toBe(125n);
      expect(Decimal.fromString("1.25", 4).raw).toBe(12500n);
    });
  });

  describe("Rescaling", () => {
    it("widens without loss and returns the same instance at an equal scale", () => {
      const d = Decimal.fromString("1.5");
      const wider = d.rescale(9);
      expect(wider.raw).toBe(1_500_000_000n);
      expect(wider.toString()).toBe("1.500000000");
      expect(d.rescale(7)).toBe(d);
    });

    it("narrows with the requested rounding mode", () => {
      const d = Decimal.fromBigInt(15n, 1); // 1.5
      expect(d.rescale(0, "trunc").raw).toBe(1n);
      expect(d.rescale(0, "ceil").raw).toBe(2n);
      expect(d.rescale(0, "half-up").raw).toBe(2n);

      const negative = Decimal.fromBigInt(-15n, 1); // -1.5
      expect(negative.rescale(0, "floor").raw).toBe(-2n);
      expect(negative.rescale(0, "trunc").raw).toBe(-1n);
    });
  });

  describe("Stroop conversion from a finer scale", () => {
    it("rounds half-up when narrowing to scale 7", () => {
      expect(Decimal.fromBigInt(4n, 8).toStroops()).toBe(0n);
      expect(Decimal.fromBigInt(5n, 8).toStroops()).toBe(1n);
      expect(Decimal.fromBigInt(1n, 8).rescale(7, "ceil").raw).toBe(1n);
    });

    it("widens a coarser scale exactly", () => {
      expect(Decimal.fromBigInt(1n, 0).toStroops()).toBe(10_000_000n);
    });
  });

  describe("Formatting", () => {
    it("renders scale-0 values without a fractional part", () => {
      expect(Decimal.fromBigInt(42n, 0).toString()).toBe("42");
      expect(Decimal.fromBigInt(-42n, 0).toString()).toBe("-42");
      expect(Decimal.zero(0).toString()).toBe("0");
    });

    it("pads the fractional part to the full scale", () => {
      expect(Decimal.fromBigInt(1n, 3).toString()).toBe("0.001");
      expect(Decimal.fromBigInt(-1n, 3).toString()).toBe("-0.001");
      expect(Decimal.zero().toString()).toBe("0.0000000");
    });

    it("formats with toFixed", () => {
      expect(Decimal.fromString("1.5").toFixed(2)).toBe("1.50");
      expect(Decimal.fromString("1.005").toFixed(2)).toBe("1.01");
      expect(Decimal.fromString("1.5").toFixed(0)).toBe("2");
      expect(Decimal.fromString("1.5").toFixed(0, "trunc")).toBe("1");
      expect(() => Decimal.one().toFixed(-1)).toThrow(RangeError);
    });
  });

  describe("Scale validation", () => {
    it("rejects a negative or fractional scale", () => {
      expect(() => Decimal.fromBigInt(1n, -1)).toThrow(RangeError);
      expect(() => Decimal.fromBigInt(1n, 1.5)).toThrow(RangeError);
      expect(() => Decimal.one(-1)).toThrow(RangeError);
      expect(() => Decimal.one().rescale(-1)).toThrow(RangeError);
    });
  });
});
