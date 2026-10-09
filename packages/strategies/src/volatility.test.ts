import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import { TimeSeries } from "./time-series";
import { ewmaVolatility, rollingVolatility } from "./volatility";

function priceSeries(
  prices: readonly string[],
  options: { intervalMs?: number; scale?: number } = {}
): TimeSeries {
  const intervalMs = options.intervalMs ?? 1_000;
  const scale = options.scale ?? 7;
  return TimeSeries.from(
    prices.map((price, index) => ({
      timestampMs: index * intervalMs,
      value: Decimal.fromString(price, scale),
    })),
    { intervalMs, scale }
  );
}

describe("volatility estimators", () => {
  it("returns an empty result for an empty series", () => {
    const empty = priceSeries([]);
    expect(rollingVolatility(empty, 3)).toEqual([]);
    expect(ewmaVolatility(empty, Decimal.fromString("0.5"))).toEqual([]);
  });

  it("computes rolling population standard deviation of returns", () => {
    const series = priceSeries(["100", "110", "99", "99"]);

    expect(rollingVolatility(series, 2).map((v) => v.toString())).toEqual([
      "0.0000000",
      "0.0000000",
      "0.1000000",
      "0.0500000",
    ]);
  });

  it("uses partial windows at the start and aligns output to each price", () => {
    const series = priceSeries(["100", "110", "99"]);
    const values = rollingVolatility(series, 5);

    expect(values).toHaveLength(series.size);
    expect(values.map((v) => v.toString())).toEqual([
      "0.0000000",
      "0.0000000",
      "0.1000000",
    ]);
  });

  it("computes EWMA volatility using the configured decay", () => {
    const series = priceSeries(["100", "110", "110"]);

    expect(
      ewmaVolatility(series, Decimal.fromString("0.5")).map((v) => v.toString())
    ).toEqual(["0.0000000", "0.1000000", "0.0707107"]);
  });

  it("returns zero for a constant price series", () => {
    const series = priceSeries(["42", "42", "42"]);

    expect(rollingVolatility(series, 2).every((v) => v.isZero())).toBe(true);
    expect(
      ewmaVolatility(series, Decimal.fromString("0.94")).every((v) =>
        v.isZero()
      )
    ).toBe(true);
  });

  it("returns every value at the series scale", () => {
    const series = priceSeries(["100.00", "110.00", "99.00"], { scale: 2 });
    const rolling = rollingVolatility(series, 2);

    expect(rolling.every((v) => v.scale === 2)).toBe(true);
    expect(rolling.map((v) => v.toString())).toEqual(["0.00", "0.00", "0.10"]);
    expect(
      ewmaVolatility(series, Decimal.fromString("0.5")).every(
        (v) => v.scale === 2
      )
    ).toBe(true);
  });

  it("validates the rolling window", () => {
    const series = priceSeries(["100"]);

    expect(() => rollingVolatility(series, 0)).toThrow(RangeError);
    expect(() => rollingVolatility(series, 1.5)).toThrow(RangeError);
  });

  it("validates the EWMA decay factor", () => {
    const series = priceSeries(["100"]);

    expect(() => ewmaVolatility(series, Decimal.zero())).toThrow(RangeError);
    expect(() => ewmaVolatility(series, Decimal.one())).toThrow(RangeError);
    expect(() => ewmaVolatility(series, Decimal.fromString("1.1"))).toThrow(
      RangeError
    );
  });

  it("checks the decay factor it was given, not a rescaled copy of it", () => {
    const coarse = priceSeries(["100.0", "110.0"], { scale: 1 });

    expect(() =>
      ewmaVolatility(coarse, Decimal.fromString("0.985"))
    ).not.toThrow();
    expect(() => ewmaVolatility(coarse, Decimal.fromString("1"))).toThrow(
      RangeError
    );
  });

  it("rejects a non-positive price", () => {
    const series = priceSeries(["100", "0"]);

    expect(() => rollingVolatility(series, 2)).toThrow(RangeError);
    expect(() => ewmaVolatility(series, Decimal.fromString("0.5"))).toThrow(
      RangeError
    );
  });
});
