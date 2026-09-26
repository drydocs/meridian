import { describe, it, expect } from "vitest";
import {
  FixedPoint,
  TimeSeries,
  type TimeSeriesEntry,
} from "./time-series";

/** Scale-0 point helper for the integer-arithmetic cases below. */
function point(timestampMs: number, value: bigint): TimeSeriesEntry {
  return { timestampMs, value: FixedPoint.from(value, 0) };
}

function mantissas(series: TimeSeries): bigint[] {
  return series.points.map((entry) => entry.value.mantissa);
}

function timestamps(series: TimeSeries): number[] {
  return series.points.map((entry) => entry.timestampMs);
}

function expectAllFixedPoint(series: TimeSeries): void {
  for (const entry of series.points) {
    expect(typeof entry.value.mantissa).toBe("bigint");
    expect(entry.value.scale).toBe(series.scale);
  }
}

describe("FixedPoint", () => {
  it("wraps a mantissa and scale without rescaling", () => {
    const value = FixedPoint.from(125n, 2);
    expect(value.mantissa).toBe(125n);
    expect(value.scale).toBe(2);
    expect(FixedPoint.toString(value)).toBe("1.25");
    expect(FixedPoint.toNumber(value)).toBe(1.25);
  });

  it("has a zero at the requested scale", () => {
    expect(FixedPoint.zero(2)).toEqual({ mantissa: 0n, scale: 2 });
  });

  it("builds whole-number values at a scale", () => {
    expect(FixedPoint.fromBigInt(3n, 2)).toEqual({ mantissa: 300n, scale: 2 });
  });

  it("parses decimal strings and pads missing fractional digits", () => {
    expect(FixedPoint.fromString("1.25", 2).mantissa).toBe(125n);
    expect(FixedPoint.fromString("-0.5", 2).mantissa).toBe(-50n);
    expect(FixedPoint.fromString("4", 3).mantissa).toBe(4000n);
    expect(FixedPoint.toString(FixedPoint.fromString("-0.5", 2))).toBe("-0.5");
  });

  it("rejects strings with too many fractional digits or garbage input", () => {
    expect(() => FixedPoint.fromString("1.234", 2)).toThrow(RangeError);
    expect(() => FixedPoint.fromString("not-a-number", 2)).toThrow(RangeError);
  });

  it("reads stroops at the implicit scale 7", () => {
    expect(FixedPoint.fromStroops(15_000_000n)).toEqual({
      mantissa: 15_000_000n,
      scale: 7,
    });
    expect(FixedPoint.toString(FixedPoint.fromStroops(15_000_000n))).toBe("1.5");
  });

  it("rescales exactly upward and with rounding when shrinking", () => {
    expect(FixedPoint.rescale(FixedPoint.from(125n, 2), 4)).toEqual({
      mantissa: 12_500n,
      scale: 4,
    });
    // 1.25 -> 1 decimal place: 12.5 rounds half away from zero to 13.
    expect(FixedPoint.rescale(FixedPoint.from(125n, 2), 1)).toEqual({
      mantissa: 13n,
      scale: 1,
    });
  });

  it("adds and subtracts exactly, rejecting mismatched scales", () => {
    const sum = FixedPoint.add(FixedPoint.from(125n, 2), FixedPoint.from(275n, 2));
    expect(sum).toEqual({ mantissa: 400n, scale: 2 });
    expect(FixedPoint.toString(sum)).toBe("4");
    expect(FixedPoint.subtract(FixedPoint.from(125n, 2), FixedPoint.from(275n, 2))).toEqual(
      { mantissa: -150n, scale: 2 }
    );
    expect(() =>
      FixedPoint.add(FixedPoint.from(1n, 2), FixedPoint.from(1n, 3))
    ).toThrow(TypeError);
  });

  it("divides by integers with an explicit rounding mode", () => {
    expect(
      FixedPoint.divideByInt(FixedPoint.from(5n, 0), 2).mantissa
    ).toBe(3n); // 2.5 rounds half away from zero
    expect(
      FixedPoint.divideByInt(FixedPoint.from(5n, 0), 2, "toward-zero").mantissa
    ).toBe(2n);
    expect(
      FixedPoint.divideByInt(FixedPoint.from(-5n, 0), 2, "floor").mantissa
    ).toBe(-3n);
    expect(
      FixedPoint.divideByInt(FixedPoint.from(-5n, 0), 2, "toward-zero").mantissa
    ).toBe(-2n);
    expect(() =>
      FixedPoint.divideByInt(FixedPoint.from(1n, 0), 0)
    ).toThrow(RangeError);
  });

  it("compares and tests equality on equal scales", () => {
    const a = FixedPoint.from(100n, 2);
    const b = FixedPoint.from(200n, 2);
    expect(FixedPoint.compare(a, b)).toBe(-1);
    expect(FixedPoint.compare(b, a)).toBe(1);
    expect(FixedPoint.compare(a, FixedPoint.from(100n, 2))).toBe(0);
    expect(FixedPoint.equals(a, FixedPoint.from(100n, 2))).toBe(true);
    expect(FixedPoint.equals(a, b)).toBe(false);
  });

  it("rejects non-bigint mantissas and negative scales", () => {
    expect(() => FixedPoint.from(1 as unknown as bigint, 2)).toThrow(TypeError);
    expect(() => FixedPoint.from(1n, -1)).toThrow(RangeError);
  });
});

describe("TimeSeries.from", () => {
  it("stores ordered fixed-point points and its interval/scale", () => {
    const series = TimeSeries.from(
      [
        point(0, 1n),
        point(1_000, 2n),
        point(2_000, 3n),
      ],
      { intervalMs: 1_000, scale: 0 }
    );
    expect(series.intervalMs).toBe(1_000);
    expect(series.scale).toBe(0);
    expect(series.size).toBe(3);
    expect(timestamps(series)).toEqual([0, 1_000, 2_000]);
    expect(mantissas(series)).toEqual([1n, 2n, 3n]);
  });

  it("rejects duplicate timestamps", () => {
    expect(() =>
      TimeSeries.from([point(0, 1n), point(1_000, 2n), point(1_000, 3n)], {
        intervalMs: 1_000,
        scale: 0,
      })
    ).toThrow(/duplicate timestamp/);
  });

  it("rejects out-of-order timestamps", () => {
    expect(() =>
      TimeSeries.from([point(1_000, 1n), point(0, 2n)], {
        intervalMs: 1_000,
        scale: 0,
      })
    ).toThrow(/strictly increasing/);
  });

  it("rejects values whose scale differs from the series scale", () => {
    expect(() =>
      TimeSeries.from(
        [{ timestampMs: 0, value: FixedPoint.from(1n, 3) }],
        { intervalMs: 1_000, scale: 2 }
      )
    ).toThrow(/expected 2/);
  });

  it("rejects a non-positive interval", () => {
    expect(() => TimeSeries.from([], { intervalMs: 0, scale: 0 })).toThrow(
      RangeError
    );
  });

  it("copies and freezes its inputs so callers cannot mutate the series", () => {
    const entries: TimeSeriesEntry[] = [point(0, 1n), point(1_000, 2n)];
    const series = TimeSeries.from(entries, { intervalMs: 1_000, scale: 0 });

    entries.push(point(2_000, 3n));
    expect(series.size).toBe(2);

    expect(Object.isFrozen(series.points)).toBe(true);
    const first = series.points[0];
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.value)).toBe(true);
  });
});

describe("TimeSeries.atOrBefore", () => {
  const series = TimeSeries.from(
    [point(1_000, 10n), point(2_000, 20n), point(3_000, 30n)],
    { intervalMs: 1_000, scale: 0 }
  );

  it("returns the point exactly at the timestamp (inclusive boundary)", () => {
    expect(series.atOrBefore(2_000)?.value.mantissa).toBe(20n);
  });

  it("returns the most recent earlier point when between samples", () => {
    expect(series.atOrBefore(2_500)?.timestampMs).toBe(2_000);
    expect(series.atOrBefore(2_500)?.value.mantissa).toBe(20n);
  });

  it("returns null before the first point", () => {
    expect(series.atOrBefore(999)).toBeNull();
    expect(series.atOrBefore(0)).toBeNull();
  });

  it("returns the last point after the last timestamp", () => {
    expect(series.atOrBefore(10_000)?.timestampMs).toBe(3_000);
    expect(series.atOrBefore(10_000)?.value.mantissa).toBe(30n);
  });

  it("returns null on an empty series", () => {
    const empty = TimeSeries.from([], { intervalMs: 1_000, scale: 0 });
    expect(empty.atOrBefore(0)).toBeNull();
  });
});

describe("TimeSeries.resample downsample", () => {
  const series = TimeSeries.from(
    [point(0, 0n), point(1_000, 10n), point(2_000, 20n), point(3_000, 30n)],
    { intervalMs: 1_000, scale: 0 }
  );

  it("aggregates each bucket by mean by default", () => {
    const resampled = series.resample(2_000);
    expect(timestamps(resampled)).toEqual([0, 2_000]);
    expect(mantissas(resampled)).toEqual([5n, 25n]);
    expect(resampled.intervalMs).toBe(2_000);
    expect(resampled.scale).toBe(0);
  });

  it("rounds a mean half away from zero", () => {
    const odd = TimeSeries.from([point(0, 1n), point(1_000, 2n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    expect(mantissas(odd.resample(2_000))).toEqual([2n]); // 1.5 -> 2
  });

  it("supports first, last and sum aggregations", () => {
    expect(mantissas(series.resample(2_000, { aggregation: "first" }))).toEqual([
      0n, 20n,
    ]);
    expect(mantissas(series.resample(2_000, { aggregation: "last" }))).toEqual([
      10n, 30n,
    ]);
    expect(mantissas(series.resample(2_000, { aggregation: "sum" }))).toEqual([
      10n, 50n,
    ]);
  });

  it("places a sample exactly on a bucket start in the later bucket", () => {
    const boundary = TimeSeries.from(
      [point(0, 1n), point(1_000, 2n), point(2_000, 3n)],
      { intervalMs: 1_000, scale: 0 }
    );
    const resampled = boundary.resample(2_000, { aggregation: "first" });
    expect(timestamps(resampled)).toEqual([0, 2_000]);
    expect(mantissas(resampled)).toEqual([1n, 3n]);
  });

  it("skips buckets with no samples instead of filling them", () => {
    const gappy = TimeSeries.from([point(0, 1n), point(4_000, 5n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    const resampled = gappy.resample(2_000);
    expect(timestamps(resampled)).toEqual([0, 4_000]);
    expect(mantissas(resampled)).toEqual([1n, 5n]);
  });

  it("rejects an unknown aggregation", () => {
    expect(() =>
      series.resample(2_000, {
        aggregation: "median" as unknown as "mean",
      })
    ).toThrow(RangeError);
  });
});

describe("TimeSeries.resample upsample", () => {
  it("carries the previous value forward between samples", () => {
    const series = TimeSeries.from(
      [point(0, 10n), point(2_000, 20n), point(4_000, 30n)],
      { intervalMs: 2_000, scale: 0 }
    );
    const resampled = series.resample(1_000);
    expect(timestamps(resampled)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(mantissas(resampled)).toEqual([10n, 10n, 20n, 20n, 30n]);
    expect(resampled.intervalMs).toBe(1_000);
  });

  it("starts at the bucket containing the first sample (no back-fill)", () => {
    const series = TimeSeries.from([point(500, 7n), point(2_500, 9n)], {
      intervalMs: 2_000,
      scale: 0,
    });
    const resampled = series.resample(1_000);
    // Leading buckets before the first sample are absent; the mid-bucket
    // sample at 500 is labelled at its bucket start (0).
    expect(timestamps(resampled)).toEqual([0, 1_000, 2_000]);
    expect(mantissas(resampled)).toEqual([7n, 7n, 9n]);
    expect(Math.min(...timestamps(resampled))).toBeGreaterThanOrEqual(0);
  });

  it("keeps every value fixed-point in a 7-decimal series", () => {
    const series = TimeSeries.from(
      [
        { timestampMs: 0, value: FixedPoint.fromStroops(15_000_000n) },
        { timestampMs: 2_000, value: FixedPoint.fromStroops(25_000_000n) },
      ],
      { intervalMs: 2_000 }
    );
    const resampled = series.resample(1_000);
    expect(series.scale).toBe(7);
    expect(mantissas(resampled)).toEqual([
      15_000_000n,
      15_000_000n,
      25_000_000n,
    ]);
    expectAllFixedPoint(resampled);
  });
});

describe("TimeSeries.resample to its own interval", () => {
  const series = TimeSeries.from(
    [point(0, 5n), point(1_000, 10n), point(2_000, 15n), point(3_000, 20n)],
    { intervalMs: 1_000, scale: 0 }
  );

  it("returns an equivalent series for every aggregation", () => {
    for (const aggregation of ["mean", "first", "last", "sum"] as const) {
      const resampled = series.resample(1_000, { aggregation });
      expect(resampled.equals(series)).toBe(true);
      expect(resampled.points).toEqual(series.points);
    }
  });

  it("returns a distinct series rather than the same instance", () => {
    const resampled = series.resample(1_000);
    expect(resampled).not.toBe(series);
  });
});

describe("TimeSeries immutability", () => {
  it("leaves the source untouched when resampling", () => {
    const series = TimeSeries.from(
      [point(0, 1n), point(1_000, 2n), point(2_000, 3n)],
      { intervalMs: 1_000, scale: 0 }
    );
    const before = series.points.map((entry) => ({
      timestampMs: entry.timestampMs,
      mantissa: entry.value.mantissa,
      scale: entry.value.scale,
    }));
    const sizeBefore = series.size;
    const pointsRef = series.points;

    series.resample(2_000);
    series.resample(500);

    expect(series.size).toBe(sizeBefore);
    expect(series.points).toBe(pointsRef);
    expect(
      series.points.map((entry) => ({
        timestampMs: entry.timestampMs,
        mantissa: entry.value.mantissa,
        scale: entry.value.scale,
      }))
    ).toEqual(before);
  });

  it("keeps every stored and resampled value fixed-point", () => {
    const series = TimeSeries.from(
      [point(0, 1n), point(1_000, 2n), point(2_000, 4n)],
      { intervalMs: 1_000, scale: 0 }
    );
    expectAllFixedPoint(series);
    expectAllFixedPoint(series.resample(2_000));
    expectAllFixedPoint(series.resample(500));
  });

  it("resamples an empty series to an empty series", () => {
    const empty = TimeSeries.from([], { intervalMs: 1_000, scale: 2 });
    const resampled = empty.resample(500);
    expect(resampled.size).toBe(0);
    expect(resampled.intervalMs).toBe(500);
    expect(resampled.scale).toBe(2);
  });
});
