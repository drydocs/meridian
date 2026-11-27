import { describe, expect, it } from "vitest";
import {
  Decimal,
  FixedPointDecimal,
  annualizeSharpe,
  computeRiskMetrics,
  maxDrawdown,
  sharpeRatio,
  valueAtRisk,
} from "@meridian/strategies";
import {
  deriveDrawdownSeries,
  deriveReturnSeries,
  deriveRiskSeries,
  periodsPerYear,
  summarizeRiskMetrics,
} from "./risk-series";
import type { MetricResult, RiskSnapshot } from "./risk-series";

function snapshots(...values: string[]): RiskSnapshot[] {
  return values.map((value) => ({
    value: FixedPointDecimal.fromString(value),
  }));
}

function strings(series: readonly Decimal[]): string[] {
  return series.map((value) => value.toString());
}

function valueOf(result: MetricResult): Decimal {
  if (result.status !== "ok") {
    throw new Error(`expected a value, got ${result.reason}`);
  }
  return result.value;
}

// Returns +10%, -10%, +10%, +10%; peaks 100, 110, 110, 110, 119.79.
const RUN = snapshots("100", "110", "99", "108.9", "119.79");

describe("deriveReturnSeries", () => {
  it("gives one simple return per step after the first snapshot", () => {
    expect(strings(deriveReturnSeries(RUN))).toEqual([
      "0.100000000000000000",
      "-0.100000000000000000",
      "0.100000000000000000",
      "0.100000000000000000",
    ]);
  });

  it("works at the engine's 18-digit scale, finer than stroops", () => {
    const [ret] = deriveReturnSeries(snapshots("3", "4"));
    expect(ret?.scale).toBe(18);
    expect(ret?.toString()).toBe("0.333333333333333333");
  });

  it("is empty for zero or one snapshot", () => {
    expect(deriveReturnSeries([])).toEqual([]);
    expect(deriveReturnSeries(snapshots("100"))).toEqual([]);
  });

  it("allows a final value of zero, a -100% step", () => {
    expect(strings(deriveReturnSeries(snapshots("100", "0")))).toEqual([
      "-1.000000000000000000",
    ]);
  });

  it("throws when a return would divide by a non-positive value", () => {
    expect(() => deriveReturnSeries(snapshots("100", "0", "10"))).toThrow(
      RangeError
    );
  });
});

describe("deriveDrawdownSeries", () => {
  it("tracks value / running peak - 1, 0 at each new peak", () => {
    expect(
      strings(deriveDrawdownSeries(snapshots("100", "120", "90", "132", "66")))
    ).toEqual([
      "0.000000000000000000",
      "0.000000000000000000",
      "-0.250000000000000000",
      "0.000000000000000000",
      "-0.500000000000000000",
    ]);
  });

  it("matches the sign maxDrawdown expects: entries are 0 or negative", () => {
    const drawdown = deriveDrawdownSeries(RUN);
    expect(drawdown.every((entry) => !entry.isPositive())).toBe(true);
    expect(maxDrawdown(drawdown).toString()).toBe("0.100000000000000000");
  });

  it("has one entry per snapshot, so it is empty only for no snapshots", () => {
    expect(deriveDrawdownSeries([])).toEqual([]);
    expect(strings(deriveDrawdownSeries(snapshots("100")))).toEqual([
      "0.000000000000000000",
    ]);
  });

  it("throws when the opening peak is not positive", () => {
    expect(() => deriveDrawdownSeries(snapshots("0", "10"))).toThrow(
      RangeError
    );
  });
});

describe("deriveRiskSeries", () => {
  it("does not mutate the snapshots it reads", () => {
    const frozen = Object.freeze(
      RUN.map((snapshot) => Object.freeze(snapshot))
    );
    const before = frozen.map((snapshot) => snapshot.value.toString());

    const series = deriveRiskSeries(frozen);

    expect(series.returns).toHaveLength(4);
    expect(series.drawdown).toHaveLength(5);
    expect(frozen.map((snapshot) => snapshot.value.toString())).toEqual(before);
  });
});

describe("periodsPerYear", () => {
  it("counts steps in a 365-day year", () => {
    expect(periodsPerYear("P1D").toString()).toBe("365.000000000000000000");
    expect(periodsPerYear("PT1H").toString()).toBe("8760.000000000000000000");
    expect(periodsPerYear("P1W").toFixed(6)).toBe("52.142857");
  });

  it("rejects a step the scenario schema rejects", () => {
    expect(() => periodsPerYear("1 day")).toThrow();
    expect(() => periodsPerYear("P0D")).toThrow(RangeError);
  });
});

describe("summarizeRiskMetrics", () => {
  it("reports the engine's metrics for the derived series", () => {
    const summary = summarizeRiskMetrics({ snapshots: RUN, step: "P1D" });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    const { drawdown, returns } = deriveRiskSeries(RUN);
    const engine = computeRiskMetrics(drawdown, returns);

    expect(summary.returnCount).toBe(4);
    expect(valueOf(summary.maxDrawdown).eq(engine.maxDrawdown)).toBe(true);
    expect(valueOf(summary.valueAtRisk).eq(engine.valueAtRisk)).toBe(true);
    expect(
      valueOf(summary.annualizedSharpe).eq(
        annualizeSharpe(engine.sharpeRatio, 365)
      )
    ).toBe(true);
  });

  it("reports the engine's downside metrics for the derived series", () => {
    const summary = summarizeRiskMetrics({ snapshots: RUN, step: "P1D" });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    const { drawdown, returns } = deriveRiskSeries(RUN);
    const engine = computeRiskMetrics(drawdown, returns, {
      periodsPerYear: 365,
    });

    expect(
      valueOf(summary.conditionalValueAtRisk).eq(engine.conditionalValueAtRisk)
    ).toBe(true);
    expect(valueOf(summary.conditionalValueAtRisk).toString()).toBe(
      "0.100000000000000000"
    );
    // Downside deviation 0.05 and mean 0.05 give a per-period Sortino of 1.
    expect(valueOf(summary.annualizedSortino).toFixed(6)).toBe("19.104973");
    // 0.05 x 365 / 0.10.
    expect(valueOf(summary.calmarRatio).toFixed(6)).toBe("182.500000");
  });

  it("keeps the downside metrics for a zero-variance run", () => {
    // Every step is +10%: no variance, no shortfall and no drawdown.
    const summary = summarizeRiskMetrics({
      snapshots: snapshots("100", "110", "121", "133.1"),
      step: "P1D",
    });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    expect(summary.annualizedSharpe).toEqual({
      status: "insufficient",
      reason: "zero-variance",
    });
    expect(valueOf(summary.conditionalValueAtRisk).toFixed(6)).toBe(
      "-0.100000"
    );
    expect(summary.annualizedSortino).toEqual({
      status: "insufficient",
      reason: "zero-downside-deviation",
    });
    expect(summary.calmarRatio).toEqual({
      status: "insufficient",
      reason: "zero-drawdown",
    });
  });

  it("gives max drawdown as a positive loss magnitude", () => {
    const summary = summarizeRiskMetrics({ snapshots: RUN, step: "P1D" });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    expect(valueOf(summary.maxDrawdown).toString()).toBe(
      "0.100000000000000000"
    );
  });

  it("annualizes Sharpe with the scenario step", () => {
    // Per-period Sharpe is 0.05 / sqrt(0.0075) = 1 / sqrt(3).
    const daily = summarizeRiskMetrics({ snapshots: RUN, step: "P1D" });
    const hourly = summarizeRiskMetrics({ snapshots: RUN, step: "PT1H" });
    if (daily.kind !== "computed" || hourly.kind !== "computed") {
      throw new Error("expected computed summaries");
    }

    expect(sharpeRatio(deriveReturnSeries(RUN)).toFixed(6)).toBe("0.577350");
    expect(valueOf(daily.annualizedSharpe).toFixed(6)).toBe("11.030261");
    expect(valueOf(hourly.annualizedSharpe).toFixed(6)).toBe("54.037024");
  });

  it("gives value at risk at the requested confidence, positive for a loss", () => {
    // k = ceil(0.05 x 4) = 1, the -10% step.
    const loss = summarizeRiskMetrics({ snapshots: RUN, step: "P1D" });
    // k = ceil(0.5 x 4) = 2, a +10% step, so the tail is a gain.
    const gain = summarizeRiskMetrics({
      snapshots: RUN,
      step: "P1D",
      confidenceLevel: 0.5,
    });
    if (loss.kind !== "computed" || gain.kind !== "computed") {
      throw new Error("expected computed summaries");
    }

    expect(loss.confidenceLevel.toFixed(2)).toBe("0.95");
    expect(valueOf(loss.valueAtRisk).toString()).toBe("0.100000000000000000");
    expect(valueOf(gain.valueAtRisk).toString()).toBe("-0.100000000000000000");
  });

  it("reports an empty drawdown series and too few returns with no snapshots", () => {
    const summary = summarizeRiskMetrics({ snapshots: [], step: "P1D" });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    expect(summary.returnCount).toBe(0);
    expect(summary.maxDrawdown).toEqual({
      status: "insufficient",
      reason: "empty-drawdown",
    });
    expect(summary.annualizedSharpe).toEqual({
      status: "insufficient",
      reason: "too-few-returns",
    });
    expect(summary.valueAtRisk).toEqual({
      status: "insufficient",
      reason: "too-few-returns",
    });
  });

  it.each([
    ["one snapshot", ["100"]],
    ["one return", ["100", "90"]],
  ])("reports too few returns for %s", (_label, values) => {
    const run = snapshots(...values);
    const summary = summarizeRiskMetrics({ snapshots: run, step: "P1D" });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    expect(summary.annualizedSharpe).toEqual({
      status: "insufficient",
      reason: "too-few-returns",
    });
    expect(summary.valueAtRisk).toEqual({
      status: "insufficient",
      reason: "too-few-returns",
    });
    // The drawdown series is not empty, so its metric is still defined.
    expect(
      valueOf(summary.maxDrawdown).eq(maxDrawdown(deriveDrawdownSeries(run)))
    ).toBe(true);
  });

  it.each([
    ["a flat run", ["100", "100", "100"], "0.000000000000000000"],
    [
      "a constant +10% run",
      ["100", "110", "121", "133.1"],
      "-0.100000000000000000",
    ],
  ])(
    "reports zero variance for %s and keeps the other metrics",
    (_l, values, varValue) => {
      const run = snapshots(...values);
      const summary = summarizeRiskMetrics({ snapshots: run, step: "P1D" });
      if (summary.kind !== "computed") throw new Error(summary.reason);

      expect(summary.annualizedSharpe).toEqual({
        status: "insufficient",
        reason: "zero-variance",
      });
      expect(valueOf(summary.maxDrawdown).toString()).toBe(
        "0.000000000000000000"
      );
      expect(valueOf(summary.valueAtRisk).toString()).toBe(varValue);
      expect(
        valueOf(summary.valueAtRisk).eq(
          valueAtRisk(deriveReturnSeries(run), 0.95)
        )
      ).toBe(true);
    }
  );

  it.each([0, 1, -0.5, 1.5, Number.NaN, 1e-7])(
    "rejects a confidence level of %s instead of throwing",
    (confidenceLevel) => {
      expect(
        summarizeRiskMetrics({ snapshots: RUN, step: "P1D", confidenceLevel })
      ).toEqual({ kind: "invalid", reason: "invalid-confidence" });
    }
  );

  it.each(["", "1 day", "P0D", "PT0S"])(
    "rejects a step of %j instead of throwing",
    (step) => {
      expect(summarizeRiskMetrics({ snapshots: RUN, step })).toEqual({
        kind: "invalid",
        reason: "invalid-step",
      });
    }
  );

  it.each([
    ["a zero value mid-run", ["100", "0", "10"]],
    ["a zero opening value", ["0"]],
    ["a negative opening value", ["-5", "10", "20"]],
  ])("reports %s instead of throwing", (_label, values) => {
    expect(
      summarizeRiskMetrics({ snapshots: snapshots(...values), step: "P1D" })
    ).toEqual({ kind: "invalid", reason: "non-positive-value" });
  });

  it("still computes a run that ends at zero", () => {
    const summary = summarizeRiskMetrics({
      snapshots: snapshots("100", "50", "0"),
      step: "P1D",
    });
    if (summary.kind !== "computed") throw new Error(summary.reason);

    expect(valueOf(summary.maxDrawdown).toString()).toBe(
      "1.000000000000000000"
    );
    expect(valueOf(summary.valueAtRisk).toString()).toBe(
      "1.000000000000000000"
    );
  });
});
