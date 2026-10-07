// Immutable time-series structure with resampling (#866).
//
// The loader, estimators, and backtest all need one shared representation of
// "a value recorded at a cadence", so data sampled at one interval can drive a
// simulation stepping at another. This module is that representation.
//
// Values are `Decimal` (see ./decimal), the package's single fixed-point
// decimal: a bigint `raw` plus a decimal `scale`. Every value in one
// `TimeSeries` shares the series scale, so aggregation is exact integer
// arithmetic. No floating point is ever used for a stored value.
//
// Ordering and duplicates
// -----------------------
// `TimeSeries.from` requires entries sorted by `timestampMs` in strictly
// increasing order. Duplicate timestamps are rejected rather than merged: one
// value per timestamp. Timestamps are non-negative safe integers (epoch
// milliseconds).
//
// Lookup boundary rule
// --------------------
// `atOrBefore(t)` returns the point with the greatest timestamp `<= t`
// (inclusive), so a point exactly on `t` wins. Before the first point it
// returns `null`; after the last point it returns the last point. It never
// looks forward.
//
// Resampling
// ----------
// Buckets are aligned to the epoch: bucket `k` covers
// `[k * targetIntervalMs, (k + 1) * targetIntervalMs)`, and every resampled
// point is stamped at its bucket start.
//
// * Downsample (`targetIntervalMs >= this.intervalMs`): each non-empty bucket
//   collapses to one point using `aggregation`, which is `mean` (the default,
//   rounded half up), `first`, `last`, or `sum`. Empty buckets are skipped, so
//   real gaps stay gaps rather than being filled.
// * Upsample (`targetIntervalMs < this.intervalMs`): each bucket takes the
//   latest source value observable by the end of that bucket
//   (`atOrBefore(bucketStart + targetIntervalMs - 1)`), a carry-forward. There
//   is no back-fill and no look-ahead: the first output point is the bucket
//   containing the first sample, so leading buckets are absent. A sample
//   landing mid-bucket is labelled at that bucket's start.
//
// Buckets align to the epoch rather than to the first point, so resampling a
// series to its own interval returns the same values on the same grid only
// when the timestamps already sit on epoch-aligned boundaries. A series
// recorded every 1000ms from 1500ms resamples to 1000ms at 1000ms and 2000ms,
// not at 1500ms and 2500ms. Choose an interval that divides the recording grid
// when the labels themselves have to round-trip.
//
// Immutability
// ------------
// `from` copies and freezes its inputs and `resample` builds a brand-new
// frozen series, so the source is never mutated.

import { Decimal, DEFAULT_DECIMAL_SCALE } from "./decimal";

/** A single timestamped value. */
export interface TimeSeriesEntry {
  /** Epoch milliseconds; a non-negative safe integer. */
  readonly timestampMs: number;
  /** The value at this timestamp, in the series' fixed-point scale. */
  readonly value: Decimal;
}

export interface TimeSeriesOptions {
  /** Nominal recording cadence in milliseconds; a positive safe integer. */
  readonly intervalMs: number;
  /** Shared decimal scale for every value. Defaults to 7, the stroop scale. */
  readonly scale?: number;
}

/** Downsample aggregations, all exact integer arithmetic. */
export type ResampleAggregation = "mean" | "first" | "last" | "sum";

export interface ResampleOptions {
  /** Aggregation used when downsampling. Defaults to `"mean"`. */
  readonly aggregation?: ResampleAggregation;
}

const AGGREGATIONS: readonly ResampleAggregation[] = [
  "mean",
  "first",
  "last",
  "sum",
];

function assertScale(scale: number, label: string): void {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError(
      `${label}: scale must be a non-negative safe integer, got ${scale}`
    );
  }
}

function assertTimestampMs(timestampMs: number, label: string): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError(
      `${label}: timestampMs must be a non-negative safe integer, got ${timestampMs}`
    );
  }
}

function assertIntervalMs(intervalMs: number, label: string): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError(
      `${label}: intervalMs must be a positive safe integer, got ${intervalMs}`
    );
  }
}

function assertEntryValue(
  value: unknown,
  label: string
): asserts value is Decimal {
  if (!(value instanceof Decimal)) {
    throw new TypeError(`${label}: expected a Decimal value`);
  }
}

/** A frozen copy of `value`, so a caller cannot mutate what the series holds. */
function copyPoint(value: Decimal): Decimal {
  return Object.freeze(new Decimal(value.raw, value.scale));
}

/**
 * Builds an epoch-aligned bucket start for a timestamp. Timestamps are
 * validated as non-negative before this is called, so integer modulo is
 * exact here.
 */
function bucketStartFor(timestampMs: number, intervalMs: number): number {
  return timestampMs - (timestampMs % intervalMs);
}

/**
 * Divides by a positive whole number, rounding at the value's own scale.
 * `Decimal.div` reads a bigint operand as raw units at the receiver's scale,
 * so the divisor is wrapped at scale 0 to mean the number itself.
 */
function divideByInt(
  value: Decimal,
  divisor: number,
  rounding: "half-up" | "trunc" | "floor"
): Decimal {
  return value.div(new Decimal(BigInt(divisor), 0), rounding);
}

/**
 * An immutable, ordered series of fixed-point values with resampling.
 *
 * Construct with {@link TimeSeries.from}; read with
 * {@link TimeSeries.atOrBefore}; derive a new series with
 * {@link TimeSeries.resample}.
 */
export class TimeSeries {
  /** Nominal recording cadence of this series, in milliseconds. */
  readonly intervalMs: number;

  /** Shared decimal scale of every value in this series. */
  readonly scale: number;

  private readonly entries: readonly TimeSeriesEntry[];

  private constructor(
    intervalMs: number,
    scale: number,
    entries: readonly TimeSeriesEntry[]
  ) {
    this.intervalMs = intervalMs;
    this.scale = scale;
    this.entries = entries;
  }

  /**
   * Validates and copies `entries` into a frozen series.
   *
   * @throws RangeError when a timestamp is invalid, ordering is not strictly
   * increasing, a timestamp repeats, `intervalMs` is not a positive integer,
   * or `scale` is not a non-negative integer.
   * @throws TypeError when an entry value is not a `Decimal`.
   */
  static from(
    entries: readonly TimeSeriesEntry[],
    options: TimeSeriesOptions
  ): TimeSeries {
    if (options === null || typeof options !== "object") {
      throw new TypeError(
        "TimeSeries.from: options with intervalMs are required"
      );
    }
    assertIntervalMs(options.intervalMs, "TimeSeries.from");
    const scale = options.scale ?? DEFAULT_DECIMAL_SCALE;
    assertScale(scale, "TimeSeries.from");
    if (!Array.isArray(entries)) {
      throw new TypeError("TimeSeries.from: entries must be an array");
    }

    const normalized: TimeSeriesEntry[] = [];
    let previousTimestamp: number | null = null;
    for (const entry of entries) {
      if (entry === null || entry === undefined || typeof entry !== "object") {
        throw new TypeError("TimeSeries.from: every entry must be an object");
      }
      assertTimestampMs(entry.timestampMs, "TimeSeries.from");
      const label = `TimeSeries.from entry ${entry.timestampMs}`;
      assertEntryValue(entry.value, label);
      if (entry.value.scale !== scale) {
        throw new RangeError(
          `${label}: has scale ${entry.value.scale}, expected ${scale}`
        );
      }
      if (previousTimestamp !== null) {
        if (entry.timestampMs === previousTimestamp) {
          throw new RangeError(
            `TimeSeries.from: duplicate timestamp ${entry.timestampMs}; timestamps must be unique`
          );
        }
        if (entry.timestampMs < previousTimestamp) {
          throw new RangeError(
            `TimeSeries.from: timestamps must be strictly increasing; ${entry.timestampMs} follows ${previousTimestamp}`
          );
        }
      }
      normalized.push(
        Object.freeze({
          timestampMs: entry.timestampMs,
          value: copyPoint(entry.value),
        })
      );
      previousTimestamp = entry.timestampMs;
    }

    return new TimeSeries(options.intervalMs, scale, Object.freeze(normalized));
  }

  /** Number of stored points. */
  get size(): number {
    return this.entries.length;
  }

  /** The frozen, ordered points. */
  get points(): readonly TimeSeriesEntry[] {
    return this.entries;
  }

  /**
   * Lookup at or before `timestampMs` (inclusive). Returns `null` when
   * `timestampMs` precedes the first point; returns the last point when it
   * follows the last.
   */
  atOrBefore(timestampMs: number): TimeSeriesEntry | null {
    assertTimestampMs(timestampMs, "TimeSeries.atOrBefore");
    const entries = this.entries;
    const first = entries[0];
    if (!first || timestampMs < first.timestampMs) return null;

    let low = 0;
    let high = entries.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = entries[mid];
      if (!candidate) break;
      if (candidate.timestampMs <= timestampMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found < 0) return null;
    return entries[found] ?? null;
  }

  /**
   * Returns a new series sampled at `targetIntervalMs`. Never mutates this
   * series. See the module header for the aggregation and fill rules.
   */
  resample(
    targetIntervalMs: number,
    options: ResampleOptions = {}
  ): TimeSeries {
    assertIntervalMs(targetIntervalMs, "TimeSeries.resample");
    const aggregation = options.aggregation ?? "mean";
    if (!AGGREGATIONS.includes(aggregation)) {
      throw new RangeError(
        `TimeSeries.resample: unknown aggregation ${String(
          aggregation
        )}; expected one of ${AGGREGATIONS.join(", ")}`
      );
    }

    if (this.entries.length === 0) {
      return TimeSeries.from([], {
        intervalMs: targetIntervalMs,
        scale: this.scale,
      });
    }

    const resampled =
      targetIntervalMs < this.intervalMs
        ? this.upsample(targetIntervalMs)
        : this.downsample(targetIntervalMs, aggregation);

    return TimeSeries.from(resampled, {
      intervalMs: targetIntervalMs,
      scale: this.scale,
    });
  }

  /** Structural equality across interval, scale, timestamps, and values. */
  equals(other: TimeSeries): boolean {
    if (!(other instanceof TimeSeries)) return false;
    if (this.intervalMs !== other.intervalMs || this.scale !== other.scale) {
      return false;
    }
    if (this.entries.length !== other.entries.length) return false;
    for (let i = 0; i < this.entries.length; i++) {
      const a = this.entries[i];
      const b = other.entries[i];
      if (!a || !b) return false;
      if (a.timestampMs !== b.timestampMs) return false;
      if (!a.value.eq(b.value)) return false;
    }
    return true;
  }

  private downsample(
    targetIntervalMs: number,
    aggregation: ResampleAggregation
  ): TimeSeriesEntry[] {
    const out: TimeSeriesEntry[] = [];
    let bucketStart: number | null = null;
    let bucket: TimeSeriesEntry[] = [];

    const flush = (): void => {
      if (bucketStart === null || bucket.length === 0) return;
      out.push(
        Object.freeze({
          timestampMs: bucketStart,
          value: this.aggregate(bucket, aggregation),
        })
      );
      bucket = [];
    };

    for (const entry of this.entries) {
      const start = bucketStartFor(entry.timestampMs, targetIntervalMs);
      if (bucketStart === null || start === bucketStart) {
        bucketStart = start;
        bucket.push(entry);
      } else {
        flush();
        bucketStart = start;
        bucket.push(entry);
      }
    }
    flush();
    return out;
  }

  private upsample(targetIntervalMs: number): TimeSeriesEntry[] {
    const first = this.entries[0];
    const last = this.entries[this.entries.length - 1];
    if (!first || !last) return [];

    const out: TimeSeriesEntry[] = [];
    const start = bucketStartFor(first.timestampMs, targetIntervalMs);
    const end = bucketStartFor(last.timestampMs, targetIntervalMs);
    for (
      let bucketStart = start;
      bucketStart <= end;
      bucketStart += targetIntervalMs
    ) {
      // Carry forward the latest value observable by the end of this bucket.
      // A bucket that ends before the first sample has nothing to carry, so
      // it is omitted (the leading gap is not back-filled).
      const carried = this.atOrBefore(bucketStart + targetIntervalMs - 1);
      if (!carried) continue;
      out.push(
        Object.freeze({ timestampMs: bucketStart, value: carried.value })
      );
    }
    return out;
  }

  private aggregate(
    bucket: readonly TimeSeriesEntry[],
    aggregation: ResampleAggregation
  ): Decimal {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (!first || !last) {
      throw new Error("TimeSeries: cannot aggregate an empty bucket");
    }
    switch (aggregation) {
      case "first":
        return first.value;
      case "last":
        return last.value;
      case "sum":
        return bucket.reduce(
          (total, entry) => total.add(entry.value),
          Decimal.zero(this.scale)
        );
      case "mean":
        return divideByInt(
          bucket.reduce(
            (total, entry) => total.add(entry.value),
            Decimal.zero(this.scale)
          ),
          bucket.length,
          "half-up"
        );
    }
  }
}
