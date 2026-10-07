import { describe, it, expect } from "vitest";
import {
  MAX_TARGET_LEVERAGE,
  MIN_TARGET_LEVERAGE,
  SizingError,
  isSizingError,
  sizePosition,
} from "./sizing";
import type { SizePositionParams } from "./sizing";
import { FixedPointDecimal } from "./types";

function capital(value: string): FixedPointDecimal {
  return FixedPointDecimal.fromString(value);
}

const PRICES = {
  long: capital("100"),
  short: capital("100"),
};

function params(
  overrides: Partial<SizePositionParams> = {}
): SizePositionParams {
  return {
    capital: capital("1000"),
    targetLeverage: capital("2"),
    prices: PRICES,
    ...overrides,
  };
}

describe("sizePosition", () => {
  it("returns the long notional, short notional and per-leg margin", () => {
    const size = sizePosition(params());

    expect(size.longNotional.toString()).toBe("2000");
    expect(size.shortNotional.toString()).toBe("2000");
    expect(size.longMargin.toString()).toBe("1000");
    expect(size.shortMargin.toString()).toBe("1000");
  });

  it("sizes both legs equally at every leverage level", () => {
    for (const leverage of ["1", "1.5", "2", "3", "10", "20"]) {
      const size = sizePosition(params({ targetLeverage: capital(leverage) }));

      expect(size.longNotional.equals(size.shortNotional)).toBe(true);
      expect(size.longMargin.equals(size.shortMargin)).toBe(true);
    }
  });

  it("scales the notional with leverage and holds the margin at the capital", () => {
    const one = sizePosition(
      params({ capital: capital("500"), targetLeverage: capital("1") })
    );
    expect(one.longNotional.toString()).toBe("500");
    expect(one.longMargin.toString()).toBe("500");

    const three = sizePosition(
      params({ capital: capital("500"), targetLeverage: capital("3") })
    );
    expect(three.longNotional.toString()).toBe("1500");
    expect(three.longMargin.toString()).toBe("500");

    const twenty = sizePosition(
      params({ capital: capital("500"), targetLeverage: capital("20") })
    );
    expect(twenty.longNotional.toString()).toBe("10000");
    expect(twenty.longMargin.toString()).toBe("500");
  });

  it("accepts both leverage bounds inclusively", () => {
    expect(MIN_TARGET_LEVERAGE.toString()).toBe("1");
    expect(MAX_TARGET_LEVERAGE.toString()).toBe("20");

    expect(() =>
      sizePosition(params({ targetLeverage: MIN_TARGET_LEVERAGE }))
    ).not.toThrow();
    expect(() =>
      sizePosition(params({ targetLeverage: MAX_TARGET_LEVERAGE }))
    ).not.toThrow();
  });

  it("is independent of the leg prices under a 1:1 hedge", () => {
    const skewed = sizePosition(
      params({
        prices: { long: capital("50"), short: capital("200") },
      })
    );

    expect(skewed.longNotional.toString()).toBe("2000");
    expect(skewed.shortNotional.toString()).toBe("2000");
    expect(skewed.longMargin.toString()).toBe("1000");
    expect(skewed.shortMargin.toString()).toBe("1000");
  });

  it("keeps stroop precision on a capital smaller than one unit", () => {
    const size = sizePosition(
      params({ capital: capital("0.0000001"), targetLeverage: capital("2") })
    );

    expect(size.longNotional.toString()).toBe("0.0000002");
    expect(size.longMargin.toString()).toBe("0.0000001");
  });

  it("rejects non-positive capital with a typed error", () => {
    for (const value of ["0", "-1"]) {
      try {
        sizePosition(params({ capital: capital(value) }));
        expect.unreachable("expected sizePosition to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SizingError);
        expect(isSizingError(error)).toBe(true);
        expect((error as SizingError).code).toBe("NON_POSITIVE_CAPITAL");
      }
    }
  });

  it("rejects leverage outside the configured range with a typed error", () => {
    for (const value of ["0", "0.9999999", "-1", "20.0000001", "101"]) {
      try {
        sizePosition(params({ targetLeverage: capital(value) }));
        expect.unreachable("expected sizePosition to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SizingError);
        expect((error as SizingError).code).toBe("INVALID_LEVERAGE");
      }
    }
  });

  it("rejects non-positive prices with a typed error", () => {
    for (const prices of [
      { long: capital("0"), short: capital("100") },
      { long: capital("100"), short: capital("0") },
      { long: capital("100"), short: capital("-1") },
    ]) {
      try {
        sizePosition(params({ prices }));
        expect.unreachable("expected sizePosition to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(SizingError);
        expect((error as SizingError).code).toBe("INVALID_PRICE");
      }
    }
  });

  it("does not treat an unrelated error as a sizing error", () => {
    expect(isSizingError(new RangeError("not a sizing error"))).toBe(false);
    expect(isSizingError("not an error at all")).toBe(false);
  });
});
