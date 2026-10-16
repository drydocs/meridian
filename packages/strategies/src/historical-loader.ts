// Historical price and rate ingestion (#865).
//
// Turns recorded market data into the {@link TimeSeries} a backtest replays,
// with no live network dependency and no floating-point step. Values are
// `Decimal` (#856), so a loaded series feeds the simulation harness directly.
//
// Input format. Two JSON shapes are accepted:
//
// 1. Row form, an array of rows or `{ rows: [...] }`. Each row names an
//    `asset`, an observation `timestamp`, and at least one of `price` or
//    `rate`:
//
//      [
//        { "asset": "USDC", "timestamp": 1710000000000, "price": "0.9999" },
//        { "asset": "USDC", "timestamp": "2024-03-09T16:00:00Z", "price": "1.0001" },
//        { "asset": "blend:USDC", "timestamp": 1710000000000, "rate": "0.0525" }
//      ]
//
//    A row with both fields contributes one point to each stream. An explicit
//    `kind` selects exactly one field, ignores the other, and is an error when
//    that field is missing.
//
// 2. Multi-stream map form, `{ streams: { [id]: { asset, kind, points } } }`,
//    where a stream may also override `scale` or `intervalMs`. The map key
//    becomes the stream id, which keeps several streams over one asset (two
//    protocols' rates, for instance) distinct.
//
// `timestamp` is epoch milliseconds as a non-negative integer, or an ISO-8601
// string parsed with `Date.parse`. Values are decimal strings (preferred,
// exact) or JSON numbers. Significant digits beyond the configured scale are
// rejected rather than rounded, which is what makes the round trip exact.
//
// Ordering. Within a stream, timestamps must be strictly increasing.
// `onOutOfOrder` governs a timestamp before its predecessor, defaulting to
// `"reject"` and accepting `"sort"`. `onDuplicate` governs an equal timestamp,
// defaulting to `"reject"` and accepting `"first"` or `"last"`.
//
// Cadence. `intervalMs` is required because `TimeSeries` carries a nominal
// recording cadence and resampling depends on it being truthful. Every gap
// between consecutive samples must be a whole number of intervals, so real gaps
// are allowed but a finer or irregular grid than the one declared is rejected
// instead of being mislabelled later.

import { Decimal, DEFAULT_DECIMAL_SCALE } from "./decimal";
import { TimeSeries, type TimeSeriesEntry } from "./time-series";

/** Default decimal places; the stroop scale used across the repo. */
export const DEFAULT_HISTORICAL_SCALE = DEFAULT_DECIMAL_SCALE;

/**
 * Largest supported scale. `Decimal` itself has no cap, but every scale costs
 * a `10 ** scale` bigint, so an unbounded value would hang on materialisation.
 */
export const MAX_HISTORICAL_SCALE = 30;

export type HistoricalValue = string | number;

/** A price feed or an interest-rate stream. */
export type StreamKind = "price" | "rate";

/** One observation in row form. */
export interface HistoricalRow {
  /** Asset id for price streams, or pool/protocol id for rate streams. */
  asset: string;
  /** Epoch milliseconds, or an ISO-8601 string. */
  timestamp: number | string;
  price?: HistoricalValue;
  rate?: HistoricalValue;
  /** Disambiguates when both `price` and `rate` are present. */
  kind?: StreamKind;
}

/** One observation in the multi-stream map form. */
export interface HistoricalStreamPoint {
  timestamp: number | string;
  value: HistoricalValue;
}

/** A named stream in the multi-stream map form. */
export interface HistoricalStream {
  asset: string;
  kind: StreamKind;
  /** Per-stream scale override; defaults to the loader's scale. */
  scale?: number;
  /** Per-stream cadence override; defaults to the loader's intervalMs. */
  intervalMs?: number;
  points: readonly HistoricalStreamPoint[];
}

export interface HistoricalRowInput {
  rows: readonly HistoricalRow[];
}

export interface HistoricalStreamMapInput {
  streams: Readonly<Record<string, HistoricalStream>>;
}

export type HistoricalInput =
  | readonly HistoricalRow[]
  | HistoricalRowInput
  | HistoricalStreamMapInput;

export type OutOfOrderPolicy = "reject" | "sort";
export type DuplicatePolicy = "reject" | "first" | "last";
export type MalformedPolicy = "reject" | "skip";

export interface LoadHistoricalOptions {
  /** Nominal recording cadence in milliseconds, shared by every stream. */
  intervalMs: number;
  /** Decimal places for every loaded value. Default 7. */
  scale?: number;
  /** How to handle out-of-order timestamps. Default `"reject"`. */
  onOutOfOrder?: OutOfOrderPolicy;
  /** How to handle duplicate timestamps. Default `"reject"`. */
  onDuplicate?: DuplicatePolicy;
  /** `"skip"` drops rows/points that cannot be parsed instead of throwing. Default `"reject"`. */
  onMalformed?: MalformedPolicy;
}

export type HistoricalLoadErrorCode =
  | "malformed-input"
  | "invalid-timestamp"
  | "invalid-value"
  | "scale"
  | "interval"
  | "out-of-order"
  | "duplicate";

/** Error thrown for every rejected load, carrying a stable machine code. */
export class HistoricalLoadError extends Error {
  readonly code: HistoricalLoadErrorCode;
  readonly stream: string | undefined;
  readonly index: number | undefined;

  constructor(
    code: HistoricalLoadErrorCode,
    message: string,
    details: { stream?: string; index?: number } = {}
  ) {
    super(message);
    this.name = "HistoricalLoadError";
    this.code = code;
    this.stream = details.stream;
    this.index = details.index;
    // Keeps `instanceof` working when the class is down-levelled by a bundler.
    Object.setPrototypeOf(this, HistoricalLoadError.prototype);
  }
}

/** One loaded stream: its identity, and the series a backtest replays. */
export interface LoadedStream {
  /** `"{kind}:{asset}"` for row-sourced streams, the map key for the map form. */
  readonly id: string;
  readonly asset: string;
  readonly kind: StreamKind;
  readonly series: TimeSeries;
}

interface NormalizedOptions {
  scale: number;
  intervalMs: number;
  onOutOfOrder: OutOfOrderPolicy;
  onDuplicate: DuplicatePolicy;
  onMalformed: MalformedPolicy;
}

interface RawPoint {
  timestamp: number;
  value: Decimal;
  /** Index of the source row/point, for error messages. */
  source: number;
}

interface Bucket {
  id: string;
  asset: string;
  kind: StreamKind;
  scale: number;
  intervalMs: number;
  points: RawPoint[];
}

// Parse failures that `onMalformed: "skip"` may drop; ordering, duplicate, and
// cadence violations are structural errors and always throw.
const SKIPPABLE: ReadonlySet<HistoricalLoadErrorCode> = new Set([
  "malformed-input",
  "invalid-timestamp",
  "invalid-value",
]);

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// Bounds a hostile or accidental exponent like `1e1000000`, which would
// otherwise try to materialise an enormous bigint.
const MAX_DECIMAL_EXPONENT = 1_000;

const POW10: bigint[] = [1n];

function powerOfTen(exponent: number): bigint {
  if (exponent < 0) {
    throw new RangeError(`powerOfTen: negative exponent ${exponent}`);
  }
  for (let i = POW10.length; i <= exponent; i++) {
    POW10.push(POW10[i - 1]! * 10n);
  }
  return POW10[exponent]!;
}

/**
 * Parses a decimal literal into a `Decimal` at exactly `scale` decimal places.
 *
 * Strings and numbers are read as decimal literals (a number via its shortest
 * round-trip representation), and scientific notation is expanded exactly, so
 * every digit the source carries survives the trip. A value needing more than
 * `scale` decimal places is rejected rather than rounded, which is what makes the
 * loader's round-trip guarantee possible; trailing zeros beyond `scale` are
 * still exact and therefore accepted (e.g. `"1.230000000"` at scale 7).
 */
function parseDecimal(raw: string, scale: number): Decimal {
  const text = raw.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new Error(`not a valid decimal: "${raw}"`);
  }
  const negative = match[1] === "-";
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > MAX_DECIMAL_EXPONENT
  ) {
    throw new Error(`decimal exponent out of range: "${raw}"`);
  }

  // value = sign * (whole.fraction) * 10^exponent
  //       = sign * digits * 10^(exponent - fraction.length)
  const digits = BigInt(`${whole}${fraction}`);
  const shift = exponent - fraction.length + scale;
  let scaled: bigint;
  if (shift >= 0) {
    scaled = digits * powerOfTen(shift);
  } else {
    const divisor = powerOfTen(-shift);
    if (digits % divisor !== 0n) {
      throw new Error(`"${raw}" has more than ${scale} decimal place(s)`);
    }
    scaled = digits / divisor;
  }
  return new Decimal(negative ? -scaled : scaled, scale);
}

function isStreamMap(input: unknown): input is HistoricalStreamMapInput {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "streams" in input
  );
}

function isRowInput(input: unknown): input is HistoricalRowInput {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "rows" in input
  );
}

function resolveScale(value: number | undefined): number {
  const scale = value ?? DEFAULT_HISTORICAL_SCALE;
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_HISTORICAL_SCALE) {
    throw new HistoricalLoadError(
      "scale",
      `scale must be an integer between 0 and ${MAX_HISTORICAL_SCALE}, received ${scale}`
    );
  }
  return scale;
}

function resolveInterval(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new HistoricalLoadError(
      "interval",
      `intervalMs must be a positive safe integer, received ${value}`
    );
  }
  return value as number;
}

function normalizeOptions(options: LoadHistoricalOptions): NormalizedOptions {
  if (options === null || typeof options !== "object") {
    throw new HistoricalLoadError(
      "interval",
      "options with intervalMs are required"
    );
  }
  return {
    intervalMs: resolveInterval(options.intervalMs),
    scale: resolveScale(options.scale),
    onOutOfOrder: options.onOutOfOrder ?? "reject",
    onDuplicate: options.onDuplicate ?? "reject",
    onMalformed: options.onMalformed ?? "reject",
  };
}

function parseTimestamp(
  raw: number | string,
  details: { stream?: string; index?: number }
): number {
  const parsed = readTimestamp(raw, details);
  if (parsed < 0) {
    throw new HistoricalLoadError(
      "invalid-timestamp",
      `timestamp ${parsed} is negative; epoch milliseconds must be non-negative`,
      details
    );
  }
  return parsed;
}

function readTimestamp(
  raw: number | string,
  details: { stream?: string; index?: number }
): number {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) {
      throw new HistoricalLoadError(
        "invalid-timestamp",
        `timestamp must be an integer number of epoch milliseconds, received ${raw}`,
        details
      );
    }
    return raw;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new HistoricalLoadError(
      "malformed-input",
      "timestamp must be an epoch-millisecond integer or an ISO-8601 string",
      details
    );
  }
  const text = raw.trim();
  if (/^[+-]?\d+$/.test(text)) {
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) {
      throw new HistoricalLoadError(
        "invalid-timestamp",
        `timestamp "${raw}" is outside the safe integer range`,
        details
      );
    }
    return parsed;
  }
  const parsed = Date.parse(text);
  if (!Number.isInteger(parsed)) {
    throw new HistoricalLoadError(
      "invalid-timestamp",
      `timestamp "${raw}" is not a valid ISO-8601 date`,
      details
    );
  }
  return parsed;
}

function parseValue(
  raw: HistoricalValue,
  scale: number,
  details: { stream?: string; index?: number }
): Decimal {
  try {
    return parseDecimal(String(raw), scale);
  } catch (error) {
    throw new HistoricalLoadError(
      "invalid-value",
      `${(error as Error).message}`,
      details
    );
  }
}

function streamId(kind: StreamKind, asset: string): string {
  return `${kind}:${asset}`;
}

function getBucket(
  buckets: Map<string, Bucket>,
  id: string,
  asset: string,
  kind: StreamKind,
  scale: number,
  intervalMs: number
): Bucket {
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { id, asset, kind, scale, intervalMs, points: [] };
    buckets.set(id, bucket);
  }
  return bucket;
}

function addRowPoint(
  buckets: Map<string, Bucket>,
  kind: StreamKind,
  asset: string,
  timestampRaw: number | string,
  valueRaw: HistoricalValue,
  index: number,
  options: NormalizedOptions
): void {
  const id = streamId(kind, asset);
  const details = { stream: id, index };
  const timestamp = parseTimestamp(timestampRaw, details);
  const value = parseValue(valueRaw, options.scale, details);
  const bucket = getBucket(
    buckets,
    id,
    asset,
    kind,
    options.scale,
    options.intervalMs
  );
  bucket.points.push({ timestamp, value, source: index });
}

function loadRows(
  rows: readonly HistoricalRow[],
  options: NormalizedOptions
 ): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  rows.forEach((row, index) => {
    try {
      if (row === null || typeof row !== "object") {
        throw new HistoricalLoadError(
          "malformed-input",
          "row must be an object",
          { index }
        );
      }
      if (typeof row.asset !== "string" || row.asset.trim() === "") {
        throw new HistoricalLoadError(
          "malformed-input",
          "row.asset must be a non-empty string",
          { index }
        );
      }
      const asset = row.asset;
      const kind = row.kind;
      if (kind !== undefined && kind !== "price" && kind !== "rate") {
        throw new HistoricalLoadError(
          "malformed-input",
          `row.kind must be "price" or "rate", received ${String(kind)}`,
          { index }
        );
      }
      if (kind === "price") {
        if (row.price === undefined) {
          throw new HistoricalLoadError(
            "malformed-input",
            `row declares kind "price" but has no price`,
            { index }
          );
        }
        addRowPoint(buckets, "price", asset, row.timestamp, row.price, index, options);
        return;
      }
      if (kind === "rate") {
        if (row.rate === undefined) {
          throw new HistoricalLoadError(
            "malformed-input",
            `row declares kind "rate" but has no rate`,
            { index }
          );
        }
        addRowPoint(buckets, "rate", asset, row.timestamp, row.rate, index, options);
        return;
      }
      if (row.price === undefined && row.rate === undefined) {
        throw new HistoricalLoadError(
          "malformed-input",
          "row must carry a price or a rate",
          { index }
        );
      }
      if (row.price !== undefined) {
        addRowPoint(buckets, "price", asset, row.timestamp, row.price, index, options);
      }
      if (row.rate !== undefined) {
        addRowPoint(buckets, "rate", asset, row.timestamp, row.rate, index, options);
      }
    } catch (error) {
      if (
        options.onMalformed === "skip" &&
        error instanceof HistoricalLoadError &&
        SKIPPABLE.has(error.code)
      ) {
        return;
      }
      throw error;
    }
  });
  return buckets;
}

function loadStreamMap(
  input: HistoricalStreamMapInput,
  options: NormalizedOptions
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  const streams = input.streams;
  if (streams === null || typeof streams !== "object") {
    throw new HistoricalLoadError(
      "malformed-input",
      "streams must be an object keyed by stream id"
    );
  }
  for (const [id, stream] of Object.entries(streams)) {
    if (stream === null || typeof stream !== "object") {
      throw new HistoricalLoadError(
        "malformed-input",
        `stream "${id}" must be an object`,
        { stream: id }
      );
    }
    if (typeof stream.asset !== "string" || stream.asset.trim() === "") {
      throw new HistoricalLoadError(
        "malformed-input",
        `stream "${id}" must name a non-empty asset`,
        { stream: id }
      );
    }
    if (stream.kind !== "price" && stream.kind !== "rate") {
      throw new HistoricalLoadError(
        "malformed-input",
        `stream "${id}" must declare kind "price" or "rate"`,
        { stream: id }
      );
    }
    if (!Array.isArray(stream.points)) {
      throw new HistoricalLoadError(
        "malformed-input",
        `stream "${id}" must carry a points array`,
        { stream: id }
      );
    }
    const scale = resolveScale(stream.scale ?? options.scale);
    const intervalMs = resolveInterval(
      stream.intervalMs ?? options.intervalMs
    );
    const bucket = getBucket(
      buckets,
      id,
      stream.asset,
      stream.kind,
      scale,
      intervalMs
    );
    stream.points.forEach((point, index) => {
      try {
        if (point === null || typeof point !== "object") {
          throw new HistoricalLoadError(
            "malformed-input",
            "point must be an object",
            { stream: id, index }
          );
        }
        const timestamp = parseTimestamp(point.timestamp, {
          stream: id,
          index,
        });
        const value = parseValue(point.value, scale, {
          stream: id,
          index,
        });
        bucket.points.push({ timestamp, value, source: index });
      } catch (error) {
        if (
          options.onMalformed === "skip" &&
          error instanceof HistoricalLoadError &&
          SKIPPABLE.has(error.code)
        ) {
          return;
        }
        throw error;
      }
    });
  }
  return buckets;
}

function orderPoints(
  bucket: Bucket,
  options: NormalizedOptions
 ): RawPoint[] {
  const points = [...bucket.points];
  if (options.onOutOfOrder === "sort") {
    points.sort((a, b) => a.timestamp - b.timestamp);
  } else {
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.timestamp < points[i - 1]!.timestamp) {
        throw new HistoricalLoadError(
          "out-of-order",
          `timestamp ${points[i]!.timestamp} precedes ${points[i - 1]!.timestamp} in stream "${bucket.id}"`,
          { stream: bucket.id, index: points[i]!.source }
        );
      }
    }
  }

  const deduped: RawPoint[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.timestamp === point.timestamp) {
      if (options.onDuplicate === "reject") {
        throw new HistoricalLoadError(
          "duplicate",
          `timestamp ${point.timestamp} appears twice in stream "${bucket.id}"`,
          { stream: bucket.id, index: point.source }
        );
      }
      if (options.onDuplicate === "last") {
        deduped[deduped.length - 1] = point;
      }
      continue;
    }
    deduped.push(point);
  }
  return deduped;
}

function assertCadence(bucket: Bucket, points: RawPoint[]): void {
  for (let i = 1; i < points.length; i++) {
    const gap = points[i]!.timestamp - points[i - 1]!.timestamp;
    if (gap % bucket.intervalMs !== 0) {
      throw new HistoricalLoadError(
        "interval",
        `gap of ${gap}ms in stream "${bucket.id}" is not a whole number of ${bucket.intervalMs}ms intervals`,
        { stream: bucket.id, index: points[i]!.source }
      );
    }
  }
}

function materialize(bucket: Bucket, points: RawPoint[]): LoadedStream {
  const entries: TimeSeriesEntry[] = points.map((point) => ({
    timestamp: point.timestamp,
    value: point.value,
  }));
  const series = new TimeSeries({
    id: bucket.id,
    asset: bucket.asset,
    kind: bucket.kind,
    intervalMs: bucket.intervalMs,
    entries,
  });
  return {
    id: bucket.id,
    asset: bucket.asset,
    kind: bucket.kind,
    series,
  };
}

/**
 * Loads recorded market data into one {@link LoadedStream} per stream.
 *
 * The returned map is keyed by stream id: `${kind}:${asset}` for row-sourced
 * streams, and the map key for the multi-stream form. Every stream is ordered,
 * deduplicated, and cadence-checked before it is returned, so a backtest
 * replaying the result never sees a malformed grid.
 */
export function loadHistorical(
  input: HistoricalInput,
  options: LoadHistoricalOptions
): Map<string, LoadedStream> {
  const normalized = normalizeOptions(options);
  let buckets: Map<string, Bucket>;
  if (Array.isArray(input)) {
    buckets = loadRows(input, normalized);
  } else if (isStreamMap(input)) {
    buckets = loadStreamMap(input, normalized);
  } else if (isRowInput(input)) {
    buckets = loadRows(input.rows, normalized);
  } else {
    throw new HistoricalLoadError(
      "malformed-input",
      "input must be an array of rows, { rows }, or { streams }"
    );
  }

  const out = new Map<string, LoadedStream>();
  for (const bucket of buckets.values()) {
    const ordered = orderPoints(bucket, normalized);
    assertCadence(bucket, ordered);
    out.set(bucket.id, materialize(bucket, ordered));
  }
  return out;
}
