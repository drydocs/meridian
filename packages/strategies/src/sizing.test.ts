import { describe, it, expect } from "vitest";
import {
  FixedPointDecimal,
  sizePosition,
  InvalidLeverageError,
  InvalidCapitalError,
  isInvalidLeverageError,
  isInvalidCapitalError,
  MIN_LEVERAGE,
  MAX_LEVERAGE,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fp(value: string): FixedPointDecimal {
  return FixedPointDecimal.fromString(value);
}

/** Build a minimal prices map — sizePosition accepts it for future use. */
const PRICES = { USDC: fp("1"), EURC: fp("1.08") };

// ---------------------------------------------------------------------------
// FixedPointDecimal arithmetic (added in task #1)
// ---------------------------------------------------------------------------

describe("FixedPointDecimal arithmetic", () => {
  it("add produces correct stroops", () => {
    expect(fp("1").add(fp("2")).toStroops()).toBe(30_000_000n);
  });

  it("subtract produces correct stroops", () => {
    expect(fp("3").subtract(fp("1")).toStroops()).toBe(20_000_000n);
  });

  it("multiply: 2 × 3 = 6", () => {
    expect(fp("2").multiply(fp("3")).toString()).toBe("6");
  });

  it("multiply preserves decimal precision: 1.5 × 2 = 3", () => {
    expect(fp("1.5").multiply(fp("2")).toString()).toBe("3");
  });

  it("multiply: 1.5 × 1.5 = 2.25", () => {
    expect(fp("1.5").multiply(fp("1.5")).toString()).toBe("2.25");
  });

  it("divide: 6 / 2 = 3", () => {
    expect(fp("6").divide(fp("2")).toString()).toBe("3");
  });

  it("divide: 10 / 4 = 2.5", () => {
    expect(fp("10").divide(fp("4")).toString()).toBe("2.5");
  });

  it("divide: 1 / 3 truncates toward zero without floating point", () => {
    // 10_000_000 * 10_000_000 / 30_000_000 = 3_333_333 stroops = 0.3333333
    expect(fp("1").divide(fp("3")).toString()).toBe("0.3333333");
    // Confirm the result is a bigint — no floats involved
    expect(typeof fp("1").divide(fp("3")).toStroops()).toBe("bigint");
  });

  it("divide by zero throws", () => {
    expect(() => fp("5").divide(fp("0"))).toThrow("division by zero");
  });

  it("isZero, isPositive, isNegative", () => {
    expect(fp("0").isZero()).toBe(true);
    expect(fp("1").isZero()).toBe(false);
    expect(fp("1").isPositive()).toBe(true);
    expect(fp("-1").isPositive()).toBe(false);
    expect(fp("-1").isNegative()).toBe(true);
    expect(fp("1").isNegative()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sizePosition — happy path
// ---------------------------------------------------------------------------

describe("sizePosition — correct outputs", () => {
  it("returns longNotional, shortNotional, and marginPerLeg", () => {
    const result = sizePosition({
      capital: fp("1000"),
      targetLeverage: fp("2"),
      prices: PRICES,
    });
    expect(result).toHaveProperty("longNotional");
    expect(result).toHaveProperty("shortNotional");
    expect(result).toHaveProperty("marginPerLeg");
  });

  it("2× leverage on 1000 capital: notionals = 2000, margin = 1000", () => {
    const { longNotional, shortNotional, marginPerLeg } = sizePosition({
      capital: fp("1000"),
      targetLeverage: fp("2"),
      prices: PRICES,
    });
    expect(longNotional.toString()).toBe("2000");
    expect(shortNotional.toString()).toBe("2000");
    expect(marginPerLeg.toString()).toBe("1000");
  });

  it("1× leverage (minimum): notional = capital, margin = capital", () => {
    const { longNotional, shortNotional, marginPerLeg } = sizePosition({
      capital: fp("500"),
      targetLeverage: fp("1"),
      prices: PRICES,
    });
    expect(longNotional.toString()).toBe("500");
    expect(shortNotional.toString()).toBe("500");
    expect(marginPerLeg.toString()).toBe("500");
  });

  it("20× leverage (maximum): notional = 20 × capital", () => {
    const { longNotional, shortNotional, marginPerLeg } = sizePosition({
      capital: fp("100"),
      targetLeverage: fp("20"),
      prices: PRICES,
    });
    expect(longNotional.toString()).toBe("2000");
    expect(shortNotional.toString()).toBe("2000");
    expect(marginPerLeg.toString()).toBe("100");
  });

  it("5× leverage on 250 capital: notional = 1250, margin = 250", () => {
    const { longNotional, shortNotional, marginPerLeg } = sizePosition({
      capital: fp("250"),
      targetLeverage: fp("5"),
      prices: PRICES,
    });
    expect(longNotional.toString()).toBe("1250");
    expect(shortNotional.toString()).toBe("1250");
    expect(marginPerLeg.toString()).toBe("250");
  });

  it("marginPerLeg always equals capital (identity invariant)", () => {
    // For any integer leverage, marginPerLeg must equal capital exactly.
    for (const [cap, lev] of [
      ["100", "1"],
      ["500", "3"],
      ["1234.56", "10"],
      ["0.0000001", "1"],
    ] as const) {
      const { marginPerLeg } = sizePosition({
        capital: fp(cap),
        targetLeverage: fp(lev),
        prices: PRICES,
      });
      expect(marginPerLeg.toString()).toBe(
        fp(cap).toString(),
        `capital=${cap} leverage=${lev}`
      );
    }
  });

  it("shortNotional always equals longNotional (delta-neutral invariant)", () => {
    const { longNotional, shortNotional } = sizePosition({
      capital: fp("750"),
      targetLeverage: fp("4"),
      prices: PRICES,
    });
    expect(shortNotional.toStroops()).toBe(longNotional.toStroops());
  });

  it("all returned values are FixedPointDecimal instances (no floats)", () => {
    const result = sizePosition({
      capital: fp("1000"),
      targetLeverage: fp("3"),
      prices: PRICES,
    });
    expect(result.longNotional).toBeInstanceOf(FixedPointDecimal);
    expect(result.shortNotional).toBeInstanceOf(FixedPointDecimal);
    expect(result.marginPerLeg).toBeInstanceOf(FixedPointDecimal);
    // Underlying representation is bigint, never float
    expect(typeof result.longNotional.toStroops()).toBe("bigint");
    expect(typeof result.shortNotional.toStroops()).toBe("bigint");
    expect(typeof result.marginPerLeg.toStroops()).toBe("bigint");
  });

  it("fractional capital with integer leverage stays exact", () => {
    // 123.4567890 × 2 = 246.913578
    const { longNotional } = sizePosition({
      capital: fp("123.456789"),
      targetLeverage: fp("2"),
      prices: PRICES,
    });
    expect(longNotional.toString()).toBe("246.913578");
  });

  it("works with an empty prices map (prices not used in sizing math)", () => {
    const { longNotional } = sizePosition({
      capital: fp("1000"),
      targetLeverage: fp("5"),
      prices: {},
    });
    expect(longNotional.toString()).toBe("5000");
  });
});

// ---------------------------------------------------------------------------
// sizePosition — validation errors
// ---------------------------------------------------------------------------

describe("sizePosition — InvalidCapitalError", () => {
  it("throws InvalidCapitalError for zero capital", () => {
    expect(() =>
      sizePosition({ capital: fp("0"), targetLeverage: fp("2"), prices: PRICES })
    ).toThrow(InvalidCapitalError);
  });

  it("throws InvalidCapitalError for negative capital", () => {
    expect(() =>
      sizePosition({ capital: fp("-100"), targetLeverage: fp("2"), prices: PRICES })
    ).toThrow(InvalidCapitalError);
  });

  it("InvalidCapitalError carries the offending capital value", () => {
    try {
      sizePosition({ capital: fp("-50"), targetLeverage: fp("2"), prices: PRICES });
    } catch (err) {
      expect(isInvalidCapitalError(err)).toBe(true);
      if (isInvalidCapitalError(err)) {
        expect(err.capital.toString()).toBe("-50");
        expect(err.name).toBe("InvalidCapitalError");
      }
    }
  });

  it("capital validation fires before leverage validation", () => {
    // Both are invalid; capital should be checked first.
    expect(() =>
      sizePosition({ capital: fp("0"), targetLeverage: fp("99"), prices: PRICES })
    ).toThrow(InvalidCapitalError);
  });
});

describe("sizePosition — InvalidLeverageError", () => {
  it("throws InvalidLeverageError for leverage below 1", () => {
    expect(() =>
      sizePosition({ capital: fp("1000"), targetLeverage: fp("0.5"), prices: PRICES })
    ).toThrow(InvalidLeverageError);
  });

  it("throws InvalidLeverageError for leverage above 20", () => {
    expect(() =>
      sizePosition({ capital: fp("1000"), targetLeverage: fp("21"), prices: PRICES })
    ).toThrow(InvalidLeverageError);
  });

  it("throws InvalidLeverageError for zero leverage", () => {
    expect(() =>
      sizePosition({ capital: fp("1000"), targetLeverage: fp("0"), prices: PRICES })
    ).toThrow(InvalidLeverageError);
  });

  it("throws InvalidLeverageError for negative leverage", () => {
    expect(() =>
      sizePosition({ capital: fp("1000"), targetLeverage: fp("-1"), prices: PRICES })
    ).toThrow(InvalidLeverageError);
  });

  it("InvalidLeverageError carries the offending leverage and bounds", () => {
    try {
      sizePosition({ capital: fp("1000"), targetLeverage: fp("25"), prices: PRICES });
    } catch (err) {
      expect(isInvalidLeverageError(err)).toBe(true);
      if (isInvalidLeverageError(err)) {
        expect(err.leverage.toString()).toBe("25");
        expect(err.minLeverage.toString()).toBe(MIN_LEVERAGE.toString());
        expect(err.maxLeverage.toString()).toBe(MAX_LEVERAGE.toString());
        expect(err.name).toBe("InvalidLeverageError");
      }
    }
  });

  it("leverage just above MAX (20.0000001) is rejected", () => {
    expect(() =>
      sizePosition({
        capital: fp("1000"),
        targetLeverage: fp("20.0000001"),
        prices: PRICES,
      })
    ).toThrow(InvalidLeverageError);
  });

  it("leverage just below MIN (0.9999999) is rejected", () => {
    expect(() =>
      sizePosition({
        capital: fp("1000"),
        targetLeverage: fp("0.9999999"),
        prices: PRICES,
      })
    ).toThrow(InvalidLeverageError);
  });
});

// ---------------------------------------------------------------------------
// Type-guard functions
// ---------------------------------------------------------------------------

describe("isInvalidLeverageError / isInvalidCapitalError type guards", () => {
  it("isInvalidLeverageError identifies InvalidLeverageError", () => {
    const err = new InvalidLeverageError(fp("25"));
    expect(isInvalidLeverageError(err)).toBe(true);
    expect(isInvalidLeverageError(new Error("other"))).toBe(false);
    expect(isInvalidLeverageError("string")).toBe(false);
    expect(isInvalidLeverageError(null)).toBe(false);
  });

  it("isInvalidCapitalError identifies InvalidCapitalError", () => {
    const err = new InvalidCapitalError(fp("0"));
    expect(isInvalidCapitalError(err)).toBe(true);
    expect(isInvalidCapitalError(new Error("other"))).toBe(false);
    expect(isInvalidCapitalError(42)).toBe(false);
    expect(isInvalidCapitalError(undefined)).toBe(false);
  });

  it("guards do not cross-match", () => {
    const leverageErr = new InvalidLeverageError(fp("25"));
    const capitalErr = new InvalidCapitalError(fp("0"));
    expect(isInvalidCapitalError(leverageErr)).toBe(false);
    expect(isInvalidLeverageError(capitalErr)).toBe(false);
  });
});
