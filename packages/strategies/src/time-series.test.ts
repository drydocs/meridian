import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import {
  TimeSeries,
  type TimeSeriesEntry,
  type TimeSeriesOptions,
} from "./time-series";

/** Scale-0 point helper for the integer-arithmetic cases below. */
function point(timestampMs: number, value: bigint): TimeSeriesEntry {
  return { timestampMs, value: new Decimal(value, 0) };
}

function raws(series: TimeSeries): bigint[] {
  return series.points.map((entry) => entry.value.raw);
}

function timestamps(series: TimeSeries): number[] {
  return series.points.map((entry) => entry.timestampMs);
}

function expectAllFixedPoint(series: TimeSeries): void {
  for (const entry of series.points) {
    expect(entry.value).toBeInstanceOf(Decimal);
    expect(entry.value.scale).toBe(series.scale);
  }
}

describe("TimeSeries.from", () => {
  it("stores ordered fixed-point points and its interval/scale", () => {
    const series = TimeSeries.from(
      [point(0, 1n), point(1_000, 2n), point(2_000, 3n)],
      { intervalMs: 1_000, scale: 0 }
    );
    expect(series.intervalMs).toBe(1_000);
    expect(series.scale).toBe(0);
    expect(series.size).toBe(3);
    expect(timestamps(series)).toEqual([0, 1_000, 2_000]);
    expect(raws(series)).toEqual([1n, 2n, 3n]);
  });

  it("defaults the scale to the stroop standard of 7", () => {
    const series = TimeSeries.from(
      [{ timestampMs: 0, value: new Decimal(15_000_000n, 7) }],
      { intervalMs: 1_000 }
    );
    expect(series.scale).toBe(7);
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
      TimeSeries.from([{ timestampMs: 0, value: new Decimal(1n, 3) }], {
        intervalMs: 1_000,
        scale: 2,
      })
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
    // The series holds a copy, so freezing it does not freeze the caller's
    // own Decimal instance.
    expect(Object.isFrozen(entries[0]?.value)).toBe(false);
  });
});

describe("TimeSeries.atOrBefore", () => {
  const series = TimeSeries.from(
    [point(1_000, 10n), point(2_000, 20n), point(3_000, 30n)],
    { intervalMs: 1_000, scale: 0 }
  );

  it("returns the point exactly at the timestamp (inclusive boundary)", () => {
    expect(series.atOrBefore(2_000)?.value.raw).toBe(20n);
  });

  it("returns the most recent earlier point when between samples", () => {
    expect(series.atOrBefore(2_500)?.timestampMs).toBe(2_000);
    expect(series.atOrBefore(2_500)?.value.raw).toBe(20n);
  });

  it("returns null before the first point", () => {
    expect(series.atOrBefore(999)).toBeNull();
    expect(series.atOrBefore(0)).toBeNull();
  });

  it("returns the last point after the last timestamp", () => {
    expect(series.atOrBefore(10_000)?.timestampMs).toBe(3_000);
    expect(series.atOrBefore(10_000)?.value.raw).toBe(30n);
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
    expect(raws(resampled)).toEqual([5n, 25n]);
    expect(resampled.intervalMs).toBe(2_000);
    expect(resampled.scale).toBe(0);
  });

  it("rounds a mean half away from zero", () => {
    const odd = TimeSeries.from([point(0, 1n), point(1_000, 2n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    expect(raws(odd.resample(2_000))).toEqual([2n]); // 1.5 -> 2
  });

  it("rounds a negative mean half away from zero", () => {
    const negative = TimeSeries.from([point(0, -1n), point(1_000, -2n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    expect(raws(negative.resample(2_000))).toEqual([-2n]); // -1.5 -> -2
  });

  it("supports first, last and sum aggregations", () => {
    expect(raws(series.resample(2_000, { aggregation: "first" }))).toEqual([
      0n,
      20n,
    ]);
    expect(raws(series.resample(2_000, { aggregation: "last" }))).toEqual([
      10n,
      30n,
    ]);
    expect(raws(series.resample(2_000, { aggregation: "sum" }))).toEqual([
      10n,
      50n,
    ]);
  });

  it("places a sample exactly on a bucket start in the later bucket", () => {
    const boundary = TimeSeries.from(
      [point(0, 1n), point(1_000, 2n), point(2_000, 3n)],
      { intervalMs: 1_000, scale: 0 }
    );
    const resampled = boundary.resample(2_000, { aggregation: "first" });
    expect(timestamps(resampled)).toEqual([0, 2_000]);
    expect(raws(resampled)).toEqual([1n, 3n]);
  });

  it("skips buckets with no samples instead of filling them", () => {
    const gappy = TimeSeries.from([point(0, 1n), point(4_000, 5n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    const resampled = gappy.resample(2_000);
    expect(timestamps(resampled)).toEqual([0, 4_000]);
    expect(raws(resampled)).toEqual([1n, 5n]);
  });

  it("keeps the series scale across an aggregation at a finer scale", () => {
    const granular = TimeSeries.from(
      [
        { timestampMs: 0, value: new Decimal(15_000_000n, 7) },
        { timestampMs: 1_000, value: new Decimal(25_000_000n, 7) },
      ],
      { intervalMs: 1_000 }
    );
    const resampled = granular.resample(2_000);
    expect(raws(resampled)).toEqual([20_000_000n]);
    expect(resampled.scale).toBe(7);
    expectAllFixedPoint(resampled);
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
    expect(raws(resampled)).toEqual([10n, 10n, 20n, 20n, 30n]);
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
    expect(raws(resampled)).toEqual([7n, 7n, 9n]);
    expect(Math.min(...timestamps(resampled))).toBeGreaterThanOrEqual(0);
  });

  it("keeps every value fixed-point in a 7-decimal series", () => {
    const series = TimeSeries.from(
      [
        { timestampMs: 0, value: new Decimal(15_000_000n, 7) },
        { timestampMs: 2_000, value: new Decimal(25_000_000n, 7) },
      ],
      { intervalMs: 2_000 }
    );
    const resampled = series.resample(1_000);
    expect(series.scale).toBe(7);
    expect(raws(resampled)).toEqual([15_000_000n, 15_000_000n, 25_000_000n]);
    expectAllFixedPoint(resampled);
  });
});

describe("TimeSeries.resample bucket alignment", () => {
  const series = TimeSeries.from(
    [point(0, 5n), point(1_000, 10n), point(2_000, 15n), point(3_000, 20n)],
    { intervalMs: 1_000, scale: 0 }
  );

  it("returns an equivalent series for every aggregation when epoch-aligned", () => {
    for (const aggregation of ["mean", "first", "last", "sum"] as const) {
      const resampled = series.resample(1_000, { aggregation });
      expect(resampled.equals(series)).toBe(true);
      expect(timestamps(resampled)).toEqual(timestamps(series));
      expect(raws(resampled)).toEqual(raws(series));
    }
  });

  it("returns a distinct series rather than the same instance", () => {
    const resampled = series.resample(1_000);
    expect(resampled).not.toBe(series);
  });

  it("moves labels onto the epoch grid when the samples are offset from it", () => {
    // Buckets align to the epoch and not to the first point, so resampling to
    // the series' own interval only round-trips timestamps that already sit on
    // a bucket boundary. The values survive; the labels move.
    const offset = TimeSeries.from([point(1_500, 1n), point(2_500, 2n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    const resampled = offset.resample(1_000);
    expect(timestamps(resampled)).toEqual([1_000, 2_000]);
    expect(raws(resampled)).toEqual([1n, 2n]);
    expect(resampled.equals(offset)).toBe(false);
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
      raw: entry.value.raw,
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
        raw: entry.value.raw,
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

describe("TimeSeries validation guards", () => {
  it("requires an options object", () => {
    expect(() =>
      TimeSeries.from([], null as unknown as TimeSeriesOptions)
    ).toThrow(TypeError);
  });

  it("requires an array of entries", () => {
    expect(() =>
      TimeSeries.from("nope" as unknown as TimeSeriesEntry[], {
        intervalMs: 1_000,
      })
    ).toThrow(TypeError);
  });

  it("rejects a null entry", () => {
    expect(() =>
      TimeSeries.from([null as unknown as TimeSeriesEntry], {
        intervalMs: 1_000,
      })
    ).toThrow(TypeError);
  });

  it("rejects a value that is not a Decimal", () => {
    expect(() =>
      TimeSeries.from([{ timestampMs: 0, value: null as unknown as Decimal }], {
        intervalMs: 1_000,
      })
    ).toThrow(TypeError);
  });

  it("rejects a plain object that only looks like a Decimal", () => {
    expect(() =>
      TimeSeries.from(
        [
          {
            timestampMs: 0,
            value: { raw: 1n, scale: 0 } as unknown as Decimal,
          },
        ],
        { intervalMs: 1_000, scale: 0 }
      )
    ).toThrow(TypeError);
  });

  it("rejects a negative or fractional timestamp", () => {
    const negative = point(-1, 1n);
    const fractional = point(1.5, 1n);
    expect(() =>
      TimeSeries.from([negative], { intervalMs: 1_000, scale: 0 })
    ).toThrow(RangeError);
    expect(() =>
      TimeSeries.from([fractional], { intervalMs: 1_000, scale: 0 })
    ).toThrow(RangeError);
  });

  it("rejects a negative or fractional scale", () => {
    expect(() => TimeSeries.from([], { intervalMs: 1_000, scale: -1 })).toThrow(
      RangeError
    );
    expect(() =>
      TimeSeries.from([], { intervalMs: 1_000, scale: 1.5 })
    ).toThrow(RangeError);
  });

  it("validates timestamps passed to atOrBefore", () => {
    const series = TimeSeries.from([point(0, 1n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    expect(() => series.atOrBefore(-1)).toThrow(RangeError);
    expect(() => series.atOrBefore(1.5)).toThrow(RangeError);
  });

  it("validates the resample target interval", () => {
    const series = TimeSeries.from([point(0, 1n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    expect(() => series.resample(0)).toThrow(RangeError);
    expect(() => series.resample(-1_000)).toThrow(RangeError);
    expect(() => series.resample(1.5)).toThrow(RangeError);
  });
});

describe("TimeSeries equality", () => {
  const base = TimeSeries.from([point(0, 1n), point(1_000, 2n)], {
    intervalMs: 1_000,
    scale: 0,
  });

  it("is false against a non-TimeSeries value", () => {
    expect(base.equals(null as unknown as TimeSeries)).toBe(false);
    expect(base.equals({} as unknown as TimeSeries)).toBe(false);
  });

  it("is false when the interval or scale differs", () => {
    const otherInterval = TimeSeries.from([point(0, 1n), point(1_000, 2n)], {
      intervalMs: 500,
      scale: 0,
    });
    const otherScale = TimeSeries.from(
      [
        { timestampMs: 0, value: new Decimal(1n, 2) },
        { timestampMs: 1_000, value: new Decimal(2n, 2) },
      ],
      { intervalMs: 1_000, scale: 2 }
    );
    expect(base.equals(otherInterval)).toBe(false);
    expect(base.equals(otherScale)).toBe(false);
  });

  it("is false when the point count differs", () => {
    const longer = TimeSeries.from(
      [point(0, 1n), point(1_000, 2n), point(2_000, 3n)],
      { intervalMs: 1_000, scale: 0 }
    );
    expect(base.equals(longer)).toBe(false);
  });

  it("is false when a timestamp or value differs", () => {
    const otherTimestamp = TimeSeries.from([point(0, 1n), point(1_500, 2n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    const otherValue = TimeSeries.from([point(0, 1n), point(1_000, 9n)], {
      intervalMs: 1_000,
      scale: 0,
    });
    expect(base.equals(otherTimestamp)).toBe(false);
    expect(base.equals(otherValue)).toBe(false);
  });
});
