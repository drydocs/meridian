import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import {
  annualizeSharpe,
  computeRiskMetrics,
  maxDrawdown,
  sharpeRatio,
  valueAtRisk,
} from "./risk-metrics";

const SCALE = 18;

/**
 * Reference series are held as exact decimal literals so every golden value
 * below can be checked by hand. Values that are not exact (anything passing
 * through a square root) are asserted at six decimals.
 */
function series(...values: string[]): Decimal[] {
  return values.map((value) => Decimal.fromString(value, SCALE));
}

describe("sharpeRatio", () => {
  it("matches a hand-worked symmetric series", () => {
    // mean 0, population variance 0.0025, stdev 0.05, excess mean -0.01.
    const ratio = sharpeRatio(
      series("-0.05", "0.05", "-0.05", "0.05"),
      Decimal.fromString("0.01", SCALE)
    );

    expect(ratio.toString()).toBe("-0.200000000000000000");
  });

  it("returns the excess mean over the population stdev", () => {
    // mean 0.025, sum of squared deviations 0.0138, variance 0.00276.
    const ratio = sharpeRatio(
      series("0.10", "-0.045", "0.06", "-0.02", "0.03")
    );

    expect(ratio.toFixed(6)).toBe("0.475867");
  });

  it("divides by sqrt(n / (n - 1)) in sample mode", () => {
    const returns = series("0.05", "-0.03");

    expect(sharpeRatio(returns).toString()).toBe("0.250000000000000000");
    // 0.25 / sqrt(2) = 0.176776695...
    expect(sharpeRatio(returns, Decimal.zero(SCALE), "sample").toFixed(6)).toBe(
      "0.176777"
    );
  });

  it("accepts stroop-scale inputs from on-chain data", () => {
    const ratio = sharpeRatio(
      [
        Decimal.fromStroops(500000n),
        Decimal.fromStroops(-500000n),
        Decimal.fromStroops(500000n),
        Decimal.fromStroops(-500000n),
      ],
      Decimal.fromStroops(100000n)
    );

    expect(ratio.toString()).toBe("-0.200000000000000000");
  });

  it("widens to an input scale above the metrics scale", () => {
    const ratio = sharpeRatio([
      Decimal.fromString("0.05", 20),
      Decimal.fromString("-0.03", 20),
    ]);

    expect(ratio.toFixed(6)).toBe("0.250000");
  });

  it("throws for fewer than two returns", () => {
    expect(() => sharpeRatio(series("0.02"))).toThrow(RangeError);
    expect(() => sharpeRatio([])).toThrow(RangeError);
  });

  it("throws for a series with no dispersion", () => {
    expect(() => sharpeRatio(series("0.02", "0.02"))).toThrow(RangeError);
  });
});

describe("annualizeSharpe", () => {
  it("scales a per-period ratio by sqrt(periodsPerYear)", () => {
    // -0.2 * sqrt(365) = -3.82099463490856...
    const perPeriod = sharpeRatio(
      series("-0.05", "0.05", "-0.05", "0.05"),
      Decimal.fromString("0.01", SCALE)
    );

    expect(annualizeSharpe(perPeriod, 365).toFixed(9)).toBe("-3.820994635");
  });

  it("accepts a Decimal period count", () => {
    const annualized = annualizeSharpe(
      Decimal.fromString("1", SCALE),
      Decimal.fromString("4", SCALE)
    );

    expect(annualized.toString()).toBe("2.000000000000000000");
  });

  it("throws for a non-positive period count", () => {
    expect(() => annualizeSharpe(Decimal.one(), 0)).toThrow(RangeError);
    expect(() => annualizeSharpe(Decimal.one(), -12)).toThrow(RangeError);
  });
});

describe("valueAtRisk", () => {
  // Ascending: -0.07, -0.05, -0.01, 0.02, 0.03.
  const returns = series("-0.01", "0.03", "-0.07", "0.02", "-0.05");

  it("reproduces the expected order statistic at each confidence level", () => {
    // k = ceil((1 - c) * 5): 1 at 0.99 through 0.80, 3 at 0.50, 5 at 0.10.
    expect(valueAtRisk(returns, 0.99).toString()).toBe("0.070000000000000000");
    expect(valueAtRisk(returns, 0.95).toString()).toBe("0.070000000000000000");
    expect(valueAtRisk(returns, 0.9).toString()).toBe("0.070000000000000000");
    expect(valueAtRisk(returns, 0.8).toString()).toBe("0.070000000000000000");
    expect(valueAtRisk(returns, 0.5).toString()).toBe("0.010000000000000000");
    expect(valueAtRisk(returns, 0.1).toString()).toBe("-0.030000000000000000");
  });

  it("clamps the rank into the series", () => {
    expect(valueAtRisk(returns, 0.999).toString()).toBe("0.070000000000000000");
    expect(valueAtRisk(returns, 0.001).toString()).toBe(
      "-0.030000000000000000"
    );
  });

  it("returns the quantile at the input scale", () => {
    const stroops = [
      Decimal.fromStroops(-100000n),
      Decimal.fromStroops(300000n),
      Decimal.fromStroops(-700000n),
      Decimal.fromStroops(200000n),
      Decimal.fromStroops(-500000n),
    ];

    expect(valueAtRisk(stroops, 0.5).toString()).toBe("0.0100000");
  });

  it("throws for a confidence outside the open unit interval", () => {
    expect(() => valueAtRisk(returns, 0)).toThrow(RangeError);
    expect(() => valueAtRisk(returns, 1)).toThrow(RangeError);
    expect(() => valueAtRisk(returns, -0.2)).toThrow(RangeError);
  });

  it("throws for an empty series", () => {
    expect(() => valueAtRisk([], 0.95)).toThrow(RangeError);
  });
});

describe("maxDrawdown", () => {
  it("returns the most negative entry", () => {
    const worst = maxDrawdown(series("0", "-0.02", "-0.05", "-0.01"));

    expect(worst.toString()).toBe("-0.050000000000000000");
  });

  it("returns zero for an empty series", () => {
    expect(maxDrawdown([]).toString()).toBe("0.000000000000000000");
  });

  it("returns zero for a series that never declines", () => {
    expect(maxDrawdown(series("0", "0", "0")).toString()).toBe(
      "0.000000000000000000"
    );
  });

  it("returns the only entry of a single-element series", () => {
    expect(maxDrawdown(series("-0.03")).toString()).toBe(
      "-0.030000000000000000"
    );
  });
});

describe("computeRiskMetrics", () => {
  const drawdown = series("0", "-0.02", "-0.05", "-0.01");
  const returns = series("-0.05", "0.05", "-0.05", "0.05");

  it("computes all three metrics from the collector's series", () => {
    const metrics = computeRiskMetrics(drawdown, returns, {
      riskFreePerPeriod: Decimal.fromString("0.01", SCALE),
      confidenceLevel: 0.95,
    });

    expect(metrics.maxDrawdown.toString()).toBe("-0.050000000000000000");
    expect(metrics.sharpeRatio.toString()).toBe("-0.200000000000000000");
    expect(metrics.valueAtRisk.toString()).toBe("0.050000000000000000");
  });

  it("defaults to population variance and 95% confidence", () => {
    const metrics = computeRiskMetrics(drawdown, returns);

    expect(metrics.sharpeRatio.toString()).toBe("0.000000000000000000");
    expect(metrics.valueAtRisk.toString()).toBe("0.050000000000000000");
  });
});
