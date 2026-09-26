import { describe, expect, it } from "vitest";
import {
  accrueFunding,
  FundingRateSeries,
  parseFixedPoint,
} from "./index";

const HOUR = 60 * 60 * 1_000;
const rate = (value: string) => ({ value: parseFixedPoint(value), intervalMs: HOUR });

describe("accrueFunding", () => {
  it("accrues positive funding as paid by longs and received by shorts", () => {
    const series = new FundingRateSeries(
      { startMs: 0, stepMs: HOUR },
      [{ timestampMs: HOUR, rate: rate("0.001") }]
    );
    const notional = parseFixedPoint("1000.00");

    expect(accrueFunding(series, { notional, side: "long" }, 0, 2 * HOUR)).toEqual(
      parseFixedPoint("-1.00000")
    );
    expect(accrueFunding(series, { notional, side: "short" }, 0, 2 * HOUR)).toEqual(
      parseFixedPoint("1.00000")
    );
  });

  it("reverses cash-flow direction for negative funding", () => {
    const series = new FundingRateSeries(
      { startMs: 0, stepMs: HOUR },
      [{ timestampMs: HOUR, rate: rate("-0.0025") }]
    );

    expect(
      accrueFunding(series, { notional: parseFixedPoint("200"), side: "long" }, 0, 2 * HOUR)
    ).toEqual(parseFixedPoint("0.5000"));
  });

  it("sums each funding interval and treats missing observations as zero", () => {
    const series = new FundingRateSeries(
      { startMs: 0, stepMs: HOUR },
      [
        { timestampMs: HOUR, rate: rate("0.01") },
        { timestampMs: 3 * HOUR, rate: rate("0.02") },
      ]
    );

    expect(
      accrueFunding(series, { notional: parseFixedPoint("100"), side: "short" }, 0, 4 * HOUR)
    ).toEqual(parseFixedPoint("3.00"));
    expect(
      accrueFunding(series, { notional: parseFixedPoint("100"), side: "short" }, HOUR, 3 * HOUR)
    ).toEqual(parseFixedPoint("1.00"));
  });

  it("returns fixed-point zero for an empty series", () => {
    const series = new FundingRateSeries({ startMs: 0, stepMs: HOUR }, []);

    expect(
      accrueFunding(series, { notional: parseFixedPoint("12.50"), side: "long" }, 0, 4 * HOUR)
    ).toEqual(parseFixedPoint("0.00"));
  });

  it("requires observations to align with the simulation clock", () => {
    expect(
      () =>
        new FundingRateSeries(
          { startMs: 0, stepMs: HOUR },
          [{ timestampMs: HOUR / 2, rate: rate("0.01") }]
        )
    ).toThrow("not aligned to the simulation clock");
  });
});