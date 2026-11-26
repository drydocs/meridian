import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import {
  annualizeSharpe,
  calmarRatio,
  computeRiskMetrics,
  conditionalValueAtRisk,
  downsideDeviation,
  maxDrawdown,
  sharpeRatio,
  sortinoRatio,
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
  it("returns the largest decline as a non-negative fraction", () => {
    const worst = maxDrawdown(series("0", "-0.02", "-0.05", "-0.01"));

    expect(worst.toString()).toBe("0.050000000000000000");
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
      "0.030000000000000000"
    );
  });
});

describe("computeRiskMetrics", () => {
  const drawdown = series("0", "-0.02", "-0.05", "-0.01");
  const returns = series("-0.05", "0.05", "-0.05", "0.05");

  it("computes the original three metrics from the collector's series", () => {
    const metrics = computeRiskMetrics(drawdown, returns, {
      riskFreePerPeriod: Decimal.fromString("0.01", SCALE),
      confidenceLevel: 0.95,
    });

    expect(metrics.maxDrawdown.toString()).toBe("0.050000000000000000");
    expect(metrics.sharpeRatio.toString()).toBe("-0.200000000000000000");
    expect(metrics.valueAtRisk.toString()).toBe("0.050000000000000000");
  });

  it("defaults to population variance and 95% confidence", () => {
    const metrics = computeRiskMetrics(drawdown, returns);

    expect(metrics.sharpeRatio.toString()).toBe("0.000000000000000000");
    expect(metrics.valueAtRisk.toString()).toBe("0.050000000000000000");
  });
});

describe("conditionalValueAtRisk", () => {
  // Ascending: -0.07, -0.05, -0.01, 0.02, 0.03.
  const returns = series("-0.01", "0.03", "-0.07", "0.02", "-0.05");

  it("averages the returns at or below the VaR threshold", () => {
    // k = ceil(0.6 * 5) = 3: tail -0.07, -0.05, -0.01, mean -0.043333...
    expect(conditionalValueAtRisk(returns, 0.4).toString()).toBe(
      "0.043333333333333333"
    );
    // k = ceil(0.4 * 5) = 2: tail -0.07, -0.05, mean -0.06.
    expect(conditionalValueAtRisk(returns, 0.6).toString()).toBe(
      "0.060000000000000000"
    );
  });

  it("equals VaR when the tail is a single return", () => {
    expect(conditionalValueAtRisk(returns, 0.95).toString()).toBe(
      "0.070000000000000000"
    );
  });

  it("is never a smaller loss than VaR", () => {
    for (const confidence of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      expect(
        conditionalValueAtRisk(returns, confidence).gte(
          valueAtRisk(returns, confidence)
        )
      ).toBe(true);
    }
  });

  it("includes every return tied with the threshold", () => {
    // k = 1 picks -0.04; the tie at -0.04 joins the tail, and -0.02 stays out.
    const tied = series("-0.04", "-0.04", "-0.02", "0.06");

    expect(conditionalValueAtRisk(tied, 0.75).toString()).toBe(
      "0.040000000000000000"
    );
  });

  it("is negative when even the tail was a gain", () => {
    const allPositive = series("0.01", "0.02", "0.03", "0.04");

    // k = ceil(0.5 * 4) = 2: tail 0.01, 0.02, mean 0.015.
    expect(conditionalValueAtRisk(allPositive, 0.5).toString()).toBe(
      "-0.015000000000000000"
    );
  });

  it("works on stroop-scale inputs", () => {
    const stroops = [
      Decimal.fromStroops(-700000n),
      Decimal.fromStroops(-500000n),
      Decimal.fromStroops(200000n),
    ];

    expect(conditionalValueAtRisk(stroops, 0.5).toFixed(7)).toBe("0.0600000");
  });

  it("throws for an empty series or an invalid confidence", () => {
    expect(() => conditionalValueAtRisk([], 0.95)).toThrow(RangeError);
    expect(() => conditionalValueAtRisk(returns, 0)).toThrow(RangeError);
    expect(() => conditionalValueAtRisk(returns, 1)).toThrow(RangeError);
  });
});

describe("downsideDeviation", () => {
  it("averages squared shortfalls over every return", () => {
    // Shortfalls -0.02 and -0.02: sum 0.0008 over n = 4, sqrt(0.0002).
    const deviation = downsideDeviation(
      series("-0.02", "0.04", "-0.02", "0.06")
    );

    expect(deviation.toFixed(9)).toBe("0.014142136");
  });

  it("matches a hand-worked series exactly", () => {
    // Only -0.02 is below 0: 0.0004 / 4 = 0.0001, sqrt 0.01.
    const deviation = downsideDeviation(
      series("-0.02", "0.005", "0.015", "0.04")
    );

    expect(deviation.toString()).toBe("0.010000000000000000");
  });

  it("measures shortfalls against a minimum acceptable return", () => {
    // MAR 0.015: only 0.01 falls short, by 0.005. 0.000025 / 2, sqrt.
    const deviation = downsideDeviation(
      series("0.01", "0.03"),
      Decimal.fromString("0.015", SCALE)
    );

    expect(deviation.toFixed(9)).toBe("0.003535534");
  });

  it("is zero for all-positive returns", () => {
    expect(downsideDeviation(series("0.01", "0.02", "0.03")).isZero()).toBe(
      true
    );
  });

  it("throws for an empty series", () => {
    expect(() => downsideDeviation([])).toThrow(RangeError);
  });
});

describe("sortinoRatio", () => {
  it("divides the excess mean by the downside deviation", () => {
    // mean 0.01, downside deviation 0.01.
    const ratio = sortinoRatio(series("-0.02", "0.005", "0.015", "0.04"));

    expect(ratio.toString()).toBe("1.000000000000000000");
  });

  it("uses the minimum acceptable return for both terms", () => {
    // (0.02 - 0.015) / sqrt(0.0000125) = sqrt(2).
    const ratio = sortinoRatio(
      series("0.01", "0.03"),
      Decimal.fromString("0.015", SCALE)
    );

    expect(ratio.toFixed(6)).toBe("1.414214");
  });

  it("is negative when the mean is below the minimum acceptable return", () => {
    // mean -0.01, shortfalls 0.03 and 0.01: sqrt(0.001 / 3).
    const ratio = sortinoRatio(series("-0.03", "-0.01", "0.01"));

    expect(ratio.toFixed(6)).toBe("-0.547723");
  });

  it("annualizes like Sharpe", () => {
    const ratio = sortinoRatio(series("-0.02", "0.005", "0.015", "0.04"));

    expect(annualizeSharpe(ratio, 4).toString()).toBe("2.000000000000000000");
  });

  it("throws for a zero downside deviation", () => {
    expect(() => sortinoRatio(series("0.01", "0.02"))).toThrow(RangeError);
  });

  it("throws for an empty series", () => {
    expect(() => sortinoRatio([])).toThrow(RangeError);
  });
});

describe("calmarRatio", () => {
  const returns = series("-0.02", "0.005", "0.015", "0.04");
  const drawdown = series("-0.02", "-0.0151", "-0.0003265", "0");

  it("divides the mean return by the maximum drawdown per period", () => {
    // 0.01 / 0.02.
    expect(calmarRatio(returns, drawdown).toString()).toBe(
      "0.500000000000000000"
    );
  });

  it("annualizes the mean return arithmetically", () => {
    // 0.01 * 365 / 0.02.
    expect(calmarRatio(returns, drawdown, 365).toString()).toBe(
      "182.500000000000000000"
    );
  });

  it("keeps the sign of the mean return", () => {
    const losing = series("-0.03", "0.01");

    // mean -0.01 / 0.03.
    expect(calmarRatio(losing, series("-0.03", "-0.0203")).toFixed(6)).toBe(
      "-0.333333"
    );
  });

  it("throws for a zero maximum drawdown", () => {
    expect(() => calmarRatio(series("0.01", "0.02"), series("0", "0"))).toThrow(
      RangeError
    );
    expect(() => calmarRatio(series("0.01"), [])).toThrow(RangeError);
  });

  it("throws for an empty return series or a non-positive period count", () => {
    expect(() => calmarRatio([], drawdown)).toThrow(RangeError);
    expect(() => calmarRatio(returns, drawdown, 0)).toThrow(RangeError);
  });
});

describe("computeRiskMetrics downside fields", () => {
  const returns = series("-0.02", "0.005", "0.015", "0.04");
  const drawdown = series("-0.02", "-0.0151", "-0.0003265", "0");

  it("reports CVaR, downside deviation, Sortino and Calmar", () => {
    const metrics = computeRiskMetrics(drawdown, returns, {
      periodsPerYear: 365,
    });

    expect(metrics.conditionalValueAtRisk.toString()).toBe(
      "0.020000000000000000"
    );
    expect(metrics.downsideDeviation.toString()).toBe("0.010000000000000000");
    expect(metrics.sortinoRatio?.toString()).toBe("1.000000000000000000");
    expect(metrics.calmarRatio?.toString()).toBe("182.500000000000000000");
  });

  it("passes the confidence and minimum acceptable return through", () => {
    const metrics = computeRiskMetrics(drawdown, returns, {
      confidenceLevel: 0.5,
      minimumAcceptableReturn: Decimal.fromString("0.01", SCALE),
    });

    // k = 2: tail -0.02, 0.005, mean -0.0075.
    expect(metrics.conditionalValueAtRisk.toString()).toBe(
      "0.007500000000000000"
    );
    // Shortfalls 0.03 and 0.005 below 0.01: sqrt(0.000925 / 4).
    expect(metrics.downsideDeviation.toFixed(9)).toBe("0.015206906");
    expect(metrics.sortinoRatio?.toString()).toBe("0.000000000000000000");
  });

  it("returns null ratios for all-positive returns with no drawdown", () => {
    const metrics = computeRiskMetrics(
      series("0", "0", "0"),
      series("0.01", "0.02")
    );

    expect(metrics.downsideDeviation.isZero()).toBe(true);
    expect(metrics.sortinoRatio).toBeNull();
    expect(metrics.calmarRatio).toBeNull();
    expect(metrics.conditionalValueAtRisk.toString()).toBe(
      "-0.010000000000000000"
    );
  });

  it("still throws for empty input", () => {
    expect(() => computeRiskMetrics([], [])).toThrow(RangeError);
  });
});
