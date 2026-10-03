import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import { ewmaVolatility, rollingVolatility, type VolatilityPricePoint } from "./volatility";

function point(timestampMs: number, price: string): VolatilityPricePoint {
  return { timestampMs, price: Decimal.fromString(price) };
}

describe("volatility estimators", () => {
  it("returns an empty result for an empty series", () => {
    expect(rollingVolatility([], 3)).toEqual([]);
    expect(ewmaVolatility([], Decimal.fromString("0.5"))).toEqual([]);
    expect(() => ewmaVolatility([], Decimal.zero())).toThrow(RangeError);
  });

  it("computes rolling population standard deviation of returns", () => {
    const series = [
      point(1, "100"),
      point(2, "110"),
      point(3, "99"),
      point(4, "99"),
    ];

    expect(rollingVolatility(series, 2).map((value) => value.toString())).toEqual([
      "0.0000000",
      "0.0000000",
      "0.1000000",
      "0.0500000",
    ]);
  });

  it("uses partial windows at the start and aligns output to each price", () => {
    const series = [point(1, "100"), point(2, "110"), point(3, "99")];

    expect(rollingVolatility(series, 5).map((value) => value.toString())).toEqual([
      "0.0000000",
      "0.0000000",
      "0.1000000",
    ]);
  });

  it("computes EWMA volatility using the configured decay", () => {
    const series = [point(1, "100"), point(2, "110"), point(3, "110")];
    const decay = Decimal.fromString("0.5");

    expect(ewmaVolatility(series, decay).map((value) => value.toString())).toEqual([
      "0.0000000",
      "0.1000000",
      "0.0707107",
    ]);
  });

  it("returns zero for a constant price series", () => {
    const series = [point(1, "42"), point(2, "42"), point(3, "42")];

    expect(rollingVolatility(series, 2).every((value) => value.isZero())).toBe(true);
    expect(
      ewmaVolatility(series, Decimal.fromString("0.94")).every((value) => value.isZero())
    ).toBe(true);
  });

  it("validates the rolling window", () => {
    const series = [point(1, "100")];

    expect(() => rollingVolatility(series, 0)).toThrow(RangeError);
    expect(() => rollingVolatility(series, 1.5)).toThrow(RangeError);
  });

  it("validates the EWMA decay factor", () => {
    const series = [point(1, "100")];

    expect(() => ewmaVolatility(series, Decimal.zero())).toThrow(RangeError);
    expect(() => ewmaVolatility(series, Decimal.one())).toThrow(RangeError);
    expect(() => ewmaVolatility(series, Decimal.fromString("1.1"))).toThrow(RangeError);
  });
});