// Minimal bigint-backed fixed-point decimals and the ordered time-series
// container the historical loader (#865) ingests into.
//
// Money and rate values in this repo are already handled as bigint stroops
// (7-decimal) everywhere else (see positions.ts / shared's fromStroops), but
// backtest data can arrive at any configured precision and must not round-trip
// through a JS `number` on the way in or out. FixedPoint keeps the value as a
// scaled bigint plus the decimal places it is scaled by, so a decimal source
// string parses to an exact integer and formats back to the same magnitude
// losslessly. This is deliberately a small, self-contained helper: the
// ingestion loader in historical-loader.ts is the only consumer, and it must
// not depend on a module that a parallel PR may add later.

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// Guard against a hostile or accidental exponent like `1e1000000`, which would
// otherwise try to materialise an enormous bigint.
const MAX_DECIMAL_EXPONENT = 1_000;

/** Largest supported number of decimal places for a {@link FixedPoint}. */
export const MAX_FIXED_PRECISION = 30;

const POW10: bigint[] = [1n];

function pow10(exponent: number): bigint {
  if (exponent < 0) {
    throw new RangeError(`pow10: negative exponent ${exponent}`);
  }
  for (let i = POW10.length; i <= exponent; i++) {
    POW10.push(POW10[i - 1]! * 10n);
  }
  return POW10[exponent]!;
}

/** Throws unless `precision` is an integer in `[0, MAX_FIXED_PRECISION]`. */
export function assertPrecision(precision: number): void {
  if (
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > MAX_FIXED_PRECISION
  ) {
    throw new RangeError(
      `precision must be an integer between 0 and ${MAX_FIXED_PRECISION}, received ${precision}`
    );
  }
}

/**
 * Parses a decimal string (or a JS number's shortest representation) into a
 * scaled bigint at `precision` decimal places.
 *
 * Unlike `Number(...)`, this never converts to a float, so every digit the
 * source carries is preserved. A value that cannot be represented exactly at
 * `precision` (more than `precision` significant decimal places) is rejected
 * rather than silently rounded, which is what makes the loader's round-trip
 * guarantee possible. Trailing zeros beyond `precision` are still exact and
 * therefore accepted (e.g. "1.230000000" at precision 7).
 */
function parseDecimalToScaled(raw: string, precision: number): bigint {
  const text = raw.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new Error(`invalid decimal value: "${raw}"`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) {
    throw new Error(`decimal exponent out of range: "${raw}"`);
  }

  const digits = BigInt(`${whole}${fraction}`);
  const scale = exponent - fraction.length + precision;
  let scaled: bigint;
  if (scale >= 0) {
    scaled = digits * pow10(scale);
  } else {
    const divisor = pow10(-scale);
    if (digits % divisor !== 0n) {
      throw new Error(
        `"${raw}" has more than ${precision} decimal place(s)`
      );
    }
    scaled = digits / divisor;
  }
  return sign * scaled;
}

function formatScaled(scaled: bigint, precision: number, trim: boolean): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const factor = pow10(precision);
  const whole = magnitude / factor;
  const fraction = magnitude % factor;
  const sign = negative ? "-" : "";
  if (precision === 0) return `${sign}${whole}`;

  let fractionText = fraction.toString().padStart(precision, "0");
  if (trim) fractionText = fractionText.replace(/0+$/, "");
  return fractionText.length === 0
    ? `${sign}${whole}`
    : `${sign}${whole}.${fractionText}`;
}

/**
 * An exact decimal: `scaled / 10 ** precision`, held as a bigint.
 *
 * Two FixedPoint values can only be combined (add/sub/compare) when they share
 * the same precision; mixing scales silently would reintroduce the units bug
 * this type exists to prevent, so it throws instead.
 */
export class FixedPoint {
  /** The value multiplied by `10 ** precision`. */
  readonly scaled: bigint;
  /** Number of decimal places `scaled` is expressed in. */
  readonly precision: number;

  private constructor(scaled: bigint, precision: number) {
    this.scaled = scaled;
    this.precision = precision;
  }

  /**
   * Parses `value` at `precision` decimal places.
   *
   * `bigint` input is treated as a whole-unit amount and scaled up by
   * `10 ** precision`; strings and numbers are treated as decimal literals.
   */
  static from(value: string | number | bigint, precision: number): FixedPoint {
    assertPrecision(precision);
    if (typeof value === "bigint") {
      return new FixedPoint(value * pow10(precision), precision);
    }
    return new FixedPoint(parseDecimalToScaled(String(value), precision), precision);
  }

  /** Wraps an already-scaled bigint (e.g. stroops) without further scaling. */
  static fromScaled(scaled: bigint, precision: number): FixedPoint {
    assertPrecision(precision);
    return new FixedPoint(scaled, precision);
  }

  static zero(precision: number): FixedPoint {
    assertPrecision(precision);
    return new FixedPoint(0n, precision);
  }

  get isZero(): boolean {
    return this.scaled === 0n;
  }

  get isNegative(): boolean {
    return this.scaled < 0n;
  }

  negate(): FixedPoint {
    return new FixedPoint(-this.scaled, this.precision);
  }

  add(other: FixedPoint): FixedPoint {
    this.assertCompatible(other);
    return new FixedPoint(this.scaled + other.scaled, this.precision);
  }

  sub(other: FixedPoint): FixedPoint {
    this.assertCompatible(other);
    return new FixedPoint(this.scaled - other.scaled, this.precision);
  }

  compare(other: FixedPoint): -1 | 0 | 1 {
    this.assertCompatible(other);
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: FixedPoint): boolean {
    return this.precision === other.precision && this.scaled === other.scaled;
  }

  /** The raw scaled integer (`value * 10 ** precision`). */
  toBigInt(): bigint {
    return this.scaled;
  }

  /**
   * Canonical decimal with trailing zeros removed, e.g. `1.2300000` at
   * precision 7 formats as `"1.23"` and `2.0000000` as `"2"`.
   */
  toString(): string {
    return formatScaled(this.scaled, this.precision, true);
  }

  /**
   * Decimal padded to exactly `precision` places, e.g. `"1.2300000"`.
   * This is the form {@link TimeSeries.toJSON} emits so a serialised point can
   * be parsed back to the identical scaled bigint.
   */
  toFixedString(): string {
    return formatScaled(this.scaled, this.precision, false);
  }

  /**
   * Lossy convenience accessor for display only; values above 2^53 scaled
   * units lose precision, so tests and round-trips must use `toBigInt()` or
   * `toString()`.
   */
  toNumber(): number {
    return Number(this.toString());
  }

  private assertCompatible(other: FixedPoint): void {
    if (this.precision !== other.precision) {
      throw new Error(
        `cannot combine FixedPoint values with different precision (${this.precision} vs ${other.precision})`
      );
    }
  }
}

/** A price feed or an interest-rate stream. */
export type StreamKind = "price" | "rate";

/** One observation in a {@link TimeSeries}. */
export interface TimeSeriesPoint {
  /** Epoch milliseconds; strictly increasing for a valid series. */
  readonly timestamp: number;
  readonly value: FixedPoint;
}

export interface SerializedTimeSeriesPoint {
  timestamp: number;
  value: string;
}

export interface SerializedTimeSeries {
  id: string;
  asset: string;
  kind: StreamKind;
  precision: number;
  points: SerializedTimeSeriesPoint[];
}

/**
 * An ordered, fixed-point series for one asset/kind pair.
 *
 * Points are always sorted by strictly increasing timestamp (the loader
 * enforces this), and every value is already a {@link FixedPoint} at
 * `precision`, so a backtest can iterate `points` directly without a parsing
 * or scaling step.
 */
export class TimeSeries {
  /** Stable stream id, `"<kind>:<asset>"` for row-sourced streams. */
  readonly id: string;
  readonly asset: string;
  readonly kind: StreamKind;
  readonly precision: number;
  readonly points: readonly TimeSeriesPoint[];

  constructor(
    id: string,
    asset: string,
    kind: StreamKind,
    precision: number,
    points: readonly TimeSeriesPoint[]
  ) {
    assertPrecision(precision);
    this.id = id;
    this.asset = asset;
    this.kind = kind;
    this.precision = precision;
    this.points = points;
  }

  static empty(
    id: string,
    asset: string,
    kind: StreamKind,
    precision: number
  ): TimeSeries {
    return new TimeSeries(id, asset, kind, precision, []);
  }

  get length(): number {
    return this.points.length;
  }

  get isEmpty(): boolean {
    return this.points.length === 0;
  }

  get first(): TimeSeriesPoint | undefined {
    return this.points[0];
  }

  get latest(): TimeSeriesPoint | undefined {
    return this.points[this.points.length - 1];
  }

  at(index: number): TimeSeriesPoint | undefined {
    return this.points[index];
  }

  /** Exact-timestamp lookup via binary search over the sorted points. */
  valueAt(timestamp: number): FixedPoint | undefined {
    let low = 0;
    let high = this.points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const point = this.points[mid]!;
      if (point.timestamp === timestamp) return point.value;
      if (point.timestamp < timestamp) low = mid + 1;
      else high = mid - 1;
    }
    return undefined;
  }

  /** Fixed-precision, JSON-safe representation (loss-free). */
  toJSON(): SerializedTimeSeries {
    return {
      id: this.id,
      asset: this.asset,
      kind: this.kind,
      precision: this.precision,
      points: this.points.map((point) => ({
        timestamp: point.timestamp,
        value: point.value.toFixedString(),
      })),
    };
  }

  [Symbol.iterator](): IterableIterator<TimeSeriesPoint> {
    return this.points[Symbol.iterator]();
  }
}
