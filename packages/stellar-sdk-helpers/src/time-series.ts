// Immutable time-series structure with resampling for the SDK (#866).
//
// The loader, estimators, and backtest all need one shared representation of
// "a value recorded at a cadence", so data sampled at one interval can drive
// a simulation stepping at another. This module is that representation.
//
// Fixed-point, never floating point
// ---------------------------------
// Every stored value is a `FixedPoint`: a bigint `mantissa` plus a decimal
// `scale` (the number of fractional digits). All values in one `TimeSeries`
// share a single scale, so aggregation is exact integer arithmetic. The only
// rounding decisions are in `mean` and in a precision-shrinking `rescale`,
// and both take an explicit rounding mode (default: half away from zero).
//
// Ordering and duplicates
// -----------------------
// `TimeSeries.from` requires entries sorted by `timestampMs` in strictly
// increasing order. Duplicate timestamps are rejected rather than merged:
// one value per timestamp. Timestamps are non-negative safe integers (epoch
// milliseconds).
//
// Lookup boundary rule
// --------------------
// `atOrBefore(t)` returns the point with the greatest timestamp `<= t`
// (inclusive): a point exactly on `t` wins. Before the first point it returns
// `null`; after the last point it returns the last point. It never looks
// forward.
//
// Resampling
// ----------
// Buckets are aligned to the epoch: bucket `k` covers
// `[k * targetIntervalMs, (k + 1) * targetIntervalMs)`, and every resampled
// point is stamped at its bucket start.
//
// * Downsample (`targetIntervalMs >= this.intervalMs`): each non-empty bucket
//   collapses to one point using `aggregation` — `mean` (default, rounded
//   half away from zero), `first`, `last`, or `sum`. Empty buckets are
//   skipped, so real gaps stay gaps rather than being filled.
// * Upsample (`targetIntervalMs < this.intervalMs`): each bucket takes the
//   latest source value observable by the end of that bucket
//   (`atOrBefore(bucketStart + targetIntervalMs - 1)`) — carry-forward. There
//   is no back-fill and no look-ahead: the first output point is the bucket
//   containing the first sample, so leading buckets (which would sit before
//   the series starts) are simply absent. A sample landing mid-bucket is
//   labelled at that bucket's start.
//
// Immutability
// ------------
// `from` copies and freezes its inputs and `resample` builds a brand-new
// frozen series, so the source is never mutated. Resampling a series to its
// own interval returns an equivalent but distinct series.

/** Decimal default used across the SDK: 7 fractional digits, i.e. stroops. */
const DEFAULT_SCALE = 7;

/** The scale of a stroop-denominated amount (1 USDC = 10^7 stroops). */
const STROOP_SCALE = 7;

/** How a division that cannot be represented exactly is rounded. */
export type RoundingMode = "half-away-from-zero" | "toward-zero" | "floor";

/** A decimal value stored as a bigint mantissa and a decimal scale. */
export interface FixedPoint {
  /** The raw integer value; `mantissa / 10^scale` is the decimal value. */
  readonly mantissa: bigint;
  /** Number of fractional decimal digits (>= 0). */
  readonly scale: number;
}

/** A single timestamped value. */
export interface TimeSeriesEntry {
  /** Epoch milliseconds; a non-negative safe integer. */
  readonly timestampMs: number;
  /** The value at this timestamp, in the series' fixed-point scale. */
  readonly value: FixedPoint;
}

export interface TimeSeriesOptions {
  /** Nominal recording cadence in milliseconds; a positive safe integer. */
  readonly intervalMs: number;
  /** Shared decimal scale for every value. Defaults to 7 (stroops). */
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

function assertScale(scale: number, label = "FixedPoint"): void {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError(
      `${label}: scale must be a non-negative safe integer, got ${scale}`
    );
  }
}

function assertFixedPoint(
  value: FixedPoint | null | undefined,
  label: string
): asserts value is FixedPoint {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new TypeError(`${label}: expected a FixedPoint object`);
  }
  const raw = value as { mantissa: unknown; scale: unknown };
  if (typeof raw.mantissa !== "bigint") {
    throw new TypeError(
      `${label}: mantissa must be a bigint, got ${typeof raw.mantissa}`
    );
  }
  if (typeof raw.scale !== "number") {
    throw new TypeError(
      `${label}: scale must be a number, got ${typeof raw.scale}`
    );
  }
  assertScale(raw.scale, label);
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

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function freezePoint(value: FixedPoint): FixedPoint {
  return Object.freeze({ mantissa: value.mantissa, scale: value.scale });
}

/**
 * Integer division with an explicit rounding rule. `denominator` must be
 * positive; `numerator` may be negative.
 */
function divideRounded(
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode
): bigint {
  if (denominator <= 0n) {
    throw new RangeError("divideRounded: denominator must be positive");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (rounding === "toward-zero") return quotient;
  if (rounding === "floor") {
    return numerator < 0n ? quotient - 1n : quotient;
  }
  const twiceAbsRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twiceAbsRemainder >= denominator) {
    return numerator < 0n ? quotient - 1n : quotient + 1n;
  }
  return quotient;
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
 * Fixed-point decimal helpers. Values are plain frozen `{ mantissa, scale }`
 * objects; nothing here uses floating point, so amounts never drift.
 */
export const FixedPoint = {
  /** Wraps a raw mantissa at `scale` (no rescaling). */
  from(mantissa: bigint, scale: number = DEFAULT_SCALE): FixedPoint {
    if (typeof mantissa !== "bigint") {
      throw new TypeError(
        `FixedPoint.from: mantissa must be a bigint, got ${typeof mantissa}`
      );
    }
    assertScale(scale);
    return freezePoint({ mantissa, scale });
  },

  /** The additive identity at `scale`. */
  zero(scale: number = DEFAULT_SCALE): FixedPoint {
    return FixedPoint.from(0n, scale);
  },

  /** A whole-number value expressed at `scale` (e.g. `3n` at scale 2 -> 3.00). */
  fromBigInt(value: bigint, scale: number = DEFAULT_SCALE): FixedPoint {
    if (typeof value !== "bigint") {
      throw new TypeError(
        `FixedPoint.fromBigInt: value must be a bigint, got ${typeof value}`
      );
    }
    assertScale(scale);
    return freezePoint({ mantissa: value * pow10(scale), scale });
  },

  /**
   * Parses a decimal string. Rejects input with more fractional digits than
   * `scale` rather than silently truncating it.
   */
  fromString(text: string, scale: number = DEFAULT_SCALE): FixedPoint {
    assertScale(scale);
    if (typeof text !== "string") {
      throw new TypeError(
        `FixedPoint.fromString: text must be a string, got ${typeof text}`
      );
    }
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
    if (!match) {
      throw new RangeError(`FixedPoint.fromString: invalid decimal: ${text}`);
    }
    const sign = match[1] ?? "";
    const whole = match[2] ?? "0";
    const fraction = match[3] ?? "";
    if (fraction.length > scale) {
      throw new RangeError(
        `FixedPoint.fromString: ${text} has more than ${scale} decimal places`
      );
    }
    const digits = `${whole}${fraction.padEnd(scale, "0")}`;
    const magnitude = BigInt(digits);
    return freezePoint({
      mantissa: sign === "-" ? -magnitude : magnitude,
      scale,
    });
  },

  /**
   * Interprets a stroop amount (implicitly scale 7) at `scale`. Exact when
   * increasing the scale; a decreasing scale rounds.
   */
  fromStroops(
    stroops: bigint,
    scale: number = STROOP_SCALE,
    rounding: RoundingMode = "half-away-from-zero"
  ): FixedPoint {
    return FixedPoint.rescale(
      FixedPoint.from(stroops, STROOP_SCALE),
      scale,
      rounding
    );
  },

  /** Converts a value to another scale, rounding when precision is lost. */
  rescale(
    value: FixedPoint,
    targetScale: number,
    rounding: RoundingMode = "half-away-from-zero"
  ): FixedPoint {
    assertFixedPoint(value, "FixedPoint.rescale");
    assertScale(targetScale, "FixedPoint.rescale");
    if (value.scale === targetScale) return freezePoint(value);
    if (targetScale > value.scale) {
      return freezePoint({
        mantissa: value.mantissa * pow10(targetScale - value.scale),
        scale: targetScale,
      });
    }
    return freezePoint({
      mantissa: divideRounded(
        value.mantissa,
        pow10(value.scale - targetScale),
        rounding
      ),
      scale: targetScale,
    });
  },

  /** Exact addition; both operands must share a scale. */
  add(a: FixedPoint, b: FixedPoint): FixedPoint {
    assertFixedPoint(a, "FixedPoint.add");
    assertFixedPoint(b, "FixedPoint.add");
    if (a.scale !== b.scale) {
      throw new TypeError(
        `FixedPoint.add: scales differ (${a.scale} vs ${b.scale}); rescale first`
      );
    }
    return freezePoint({ mantissa: a.mantissa + b.mantissa, scale: a.scale });
  },

  /** Exact subtraction; both operands must share a scale. */
  subtract(a: FixedPoint, b: FixedPoint): FixedPoint {
    assertFixedPoint(a, "FixedPoint.subtract");
    assertFixedPoint(b, "FixedPoint.subtract");
    if (a.scale !== b.scale) {
      throw new TypeError(
        `FixedPoint.subtract: scales differ (${a.scale} vs ${b.scale}); rescale first`
      );
    }
    return freezePoint({ mantissa: a.mantissa - b.mantissa, scale: a.scale });
  },

  /** Divides by a positive integer, rounding per `rounding`. */
  divideByInt(
    value: FixedPoint,
    divisor: number | bigint,
    rounding: RoundingMode = "half-away-from-zero"
  ): FixedPoint {
    assertFixedPoint(value, "FixedPoint.divideByInt");
    if (typeof divisor === "number" && !Number.isSafeInteger(divisor)) {
      throw new RangeError(
        `FixedPoint.divideByInt: divisor must be a safe integer, got ${divisor}`
      );
    }
    const bigDivisor = typeof divisor === "bigint" ? divisor : BigInt(divisor);
    if (bigDivisor <= 0n) {
      throw new RangeError("FixedPoint.divideByInt: divisor must be positive");
    }
    return freezePoint({
      mantissa: divideRounded(value.mantissa, bigDivisor, rounding),
      scale: value.scale,
    });
  },

  /** Ordering across equal scales: -1, 0 or 1. */
  compare(a: FixedPoint, b: FixedPoint): -1 | 0 | 1 {
    assertFixedPoint(a, "FixedPoint.compare");
    assertFixedPoint(b, "FixedPoint.compare");
    if (a.scale !== b.scale) {
      throw new TypeError(
        `FixedPoint.compare: scales differ (${a.scale} vs ${b.scale}); rescale first`
      );
    }
    if (a.mantissa < b.mantissa) return -1;
    if (a.mantissa > b.mantissa) return 1;
    return 0;
  },

  /** Same scale and same mantissa. */
  equals(a: FixedPoint, b: FixedPoint): boolean {
    assertFixedPoint(a, "FixedPoint.equals");
    assertFixedPoint(b, "FixedPoint.equals");
    return a.scale === b.scale && a.mantissa === b.mantissa;
  },

  /** Decimal string with trailing fractional zeros trimmed. */
  toString(value: FixedPoint): string {
    assertFixedPoint(value, "FixedPoint.toString");
    const negative = value.mantissa < 0n;
    const magnitude = negative ? -value.mantissa : value.mantissa;
    const sign = negative ? "-" : "";
    if (value.scale === 0) return `${sign}${magnitude}`;
    const unit = pow10(value.scale);
    const whole = magnitude / unit;
    const fraction = (magnitude % unit)
      .toString()
      .padStart(value.scale, "0")
      .replace(/0+$/, "");
    return fraction.length === 0
      ? `${sign}${whole}`
      : `${sign}${whole}.${fraction}`;
  },

  /** Lossy `number` view; for display and tests, never for stored values. */
  toNumber(value: FixedPoint): number {
    assertFixedPoint(value, "FixedPoint.toNumber");
    return Number(value.mantissa) / Number(pow10(value.scale));
  },
} as const;

/**
 * An immutable, ordered series of fixed-point values with resampling.
 *
 * Construct with {@link TimeSeries.from}; read with {@link TimeSeries.atOrBefore};
 * derive a new series with {@link TimeSeries.resample}.
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
   * increasing, a timestamp repeats, or `intervalMs` is not a positive
   * integer.
   * @throws TypeError when an entry value is not a `FixedPoint`.
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
    const scale = options.scale ?? DEFAULT_SCALE;
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
      assertFixedPoint(entry.value, `TimeSeries.from entry ${entry.timestampMs}`);
      if (entry.value.scale !== scale) {
        throw new RangeError(
          `TimeSeries.from: entry ${entry.timestampMs} has scale ${entry.value.scale}, expected ${scale}`
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
          value: freezePoint(entry.value),
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
   * series. See the module header for the exact aggregation and fill rules.
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

  /** Structural equality across interval, scale, timestamps, and mantissas. */
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
      if (a.value.scale !== b.value.scale) return false;
      if (a.value.mantissa !== b.value.mantissa) return false;
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
      // it is omitted (leading gap is not back-filled).
      const carried = this.atOrBefore(
        bucketStart + targetIntervalMs - 1
      );
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
  ): FixedPoint {
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
      case "sum": {
        let total = FixedPoint.zero(this.scale);
        for (const entry of bucket) total = FixedPoint.add(total, entry.value);
        return total;
      }
      case "mean": {
        let total = FixedPoint.zero(this.scale);
        for (const entry of bucket) total = FixedPoint.add(total, entry.value);
        return FixedPoint.divideByInt(
          total,
          BigInt(bucket.length),
          "half-away-from-zero"
        );
      }
    }
  }
}
