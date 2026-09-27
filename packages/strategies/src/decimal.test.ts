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
        const rawA = BigInt(Math.floor(Math.random() * 1000000000000) - 500000000000);
        const rawB = BigInt(Math.floor(Math.random() * 1000000000000) - 500000000000);

        const a = Decimal.fromBigInt(rawA);
        const b = Decimal.fromBigInt(rawB);

        const result = a.add(b).sub(b);
        expect(result.raw).toBe(a.raw);
        expect(result.eq(a)).toBe(true);
      }
    });
  });
});
