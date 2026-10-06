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
  readonly HistoricalRow[] | HistoricalRowInput | HistoricalStreamMapInput;

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
  /** `"<kind>:<asset>"` for row-sourced streams, the map key for the map form. */
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
 * `scale` decimal places is rejected rather than rounded, which is what makes
 * the loader's round-trip guarantee possible; trailing zeros beyond `scale` are
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
  } catch (err) {
    throw new HistoricalLoadError(
      "invalid-value",
      err instanceof Error ? err.message : String(err),
      details
    );
  }
}

function isStreamKind(value: unknown): value is StreamKind {
  return value === "price" || value === "rate";
}

function hasValue(value: unknown): value is HistoricalValue {
  return typeof value === "string" || typeof value === "number";
}

function isSkippable(err: unknown): boolean {
  return err instanceof HistoricalLoadError && SKIPPABLE.has(err.code);
}

function bucketFor(
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

function collectRow(
  row: HistoricalRow,
  index: number,
  options: NormalizedOptions,
  buckets: Map<string, Bucket>
): void {
  if (!row || typeof row !== "object") {
    throw new HistoricalLoadError(
      "malformed-input",
      `row ${index} must be an object`,
      { index }
    );
  }
  if (typeof row.asset !== "string" || row.asset.trim() === "") {
    throw new HistoricalLoadError(
      "malformed-input",
      `row ${index} must have a non-empty string "asset"`,
      { index }
    );
  }
  const asset = row.asset;
  const timestamp = parseTimestamp(row.timestamp, { stream: asset, index });

  const contributions: Array<{ kind: StreamKind; raw: HistoricalValue }> = [];
  if (row.kind !== undefined) {
    if (!isStreamKind(row.kind)) {
      throw new HistoricalLoadError(
        "malformed-input",
        `row ${index} has invalid "kind": ${JSON.stringify(row.kind)}`,
        { stream: asset, index }
      );
    }
    const value = row.kind === "price" ? row.price : row.rate;
    if (!hasValue(value)) {
      throw new HistoricalLoadError(
        "malformed-input",
        `row ${index} declares kind "${row.kind}" but is missing a "${row.kind}" value`,
        { stream: asset, index }
      );
    }
    contributions.push({ kind: row.kind, raw: value });
  } else {
    if (hasValue(row.price)) {
      contributions.push({ kind: "price", raw: row.price });
    }
    if (hasValue(row.rate)) {
      contributions.push({ kind: "rate", raw: row.rate });
    }
    if (contributions.length === 0) {
      throw new HistoricalLoadError(
        "malformed-input",
        `row ${index} must provide at least one of "price" or "rate"`,
        { stream: asset, index }
      );
    }
  }

  // Parse every value this row contributes before touching a bucket, so a row
  // that fails on its second field doesn't leave a partial point behind.
  const parsed = contributions.map(({ kind, raw }) => {
    const id = `${kind}:${asset}`;
    return {
      kind,
      id,
      value: parseValue(raw, options.scale, { stream: id, index }),
    };
  });
  for (const point of parsed) {
    bucketFor(
      buckets,
      point.id,
      asset,
      point.kind,
      options.scale,
      options.intervalMs
    ).points.push({
      timestamp,
      value: point.value,
      source: index,
    });
  }
}

function collectRows(
  rows: readonly HistoricalRow[],
  options: NormalizedOptions,
  buckets: Map<string, Bucket>
): void {
  for (let index = 0; index < rows.length; index++) {
    try {
      collectRow(rows[index]!, index, options, buckets);
    } catch (err) {
      if (options.onMalformed === "skip" && isSkippable(err)) {
        continue;
      }
      throw err;
    }
  }
}

function collectStreams(
  streams: Readonly<Record<string, HistoricalStream>>,
  options: NormalizedOptions,
  buckets: Map<string, Bucket>
): void {
  for (const [id, stream] of Object.entries(streams)) {
    let bucket: Bucket;
    try {
      if (id.trim() === "") {
        throw new HistoricalLoadError(
          "malformed-input",
          "stream map contains an empty stream id"
        );
      }
      if (!stream || typeof stream !== "object") {
        throw new HistoricalLoadError(
          "malformed-input",
          `stream "${id}" must be an object`,
          { stream: id }
        );
      }
      if (typeof stream.asset !== "string" || stream.asset.trim() === "") {
        throw new HistoricalLoadError(
          "malformed-input",
          `stream "${id}" must have a non-empty string "asset"`,
          { stream: id }
        );
      }
      if (!isStreamKind(stream.kind)) {
        throw new HistoricalLoadError(
          "malformed-input",
          `stream "${id}" must have kind "price" or "rate"`,
          { stream: id }
        );
      }
      if (!Array.isArray(stream.points)) {
        throw new HistoricalLoadError(
          "malformed-input",
          `stream "${id}" must have a "points" array`,
          { stream: id }
        );
      }
      bucket = bucketFor(
        buckets,
        id,
        stream.asset,
        stream.kind,
        resolveScale(stream.scale ?? options.scale),
        resolveInterval(stream.intervalMs ?? options.intervalMs)
      );
    } catch (err) {
      if (options.onMalformed === "skip" && isSkippable(err)) {
        continue;
      }
      throw err;
    }

    // Each point is handled independently so `onMalformed: "skip"` drops only
    // the bad observation, not the rest of the stream.
    for (let index = 0; index < stream.points.length; index++) {
      try {
        const point = stream.points[index]!;
        if (!point || typeof point !== "object") {
          throw new HistoricalLoadError(
            "malformed-input",
            `stream "${id}" point ${index} must be an object`,
            { stream: id, index }
          );
        }
        const timestamp = parseTimestamp(point.timestamp, {
          stream: id,
          index,
        });
        if (!hasValue(point.value)) {
          throw new HistoricalLoadError(
            "malformed-input",
            `stream "${id}" point ${index} must have a "value"`,
            { stream: id, index }
          );
        }
        bucket.points.push({
          timestamp,
          value: parseValue(point.value, bucket.scale, {
            stream: id,
            index,
          }),
          source: index,
        });
      } catch (err) {
        if (options.onMalformed === "skip" && isSkippable(err)) {
          continue;
        }
        throw err;
      }
    }
  }
}

/**
 * Throws unless the kept timestamps sit on the declared cadence. A gap of
 * several intervals means missing samples, which is legitimate; a gap that is
 * not a whole number of intervals means the declared cadence is wrong.
 */
function assertCadence(bucket: Bucket, kept: readonly RawPoint[]): void {
  for (let i = 1; i < kept.length; i++) {
    const previous = kept[i - 1]!;
    const point = kept[i]!;
    const gap = point.timestamp - previous.timestamp;
    if (gap % bucket.intervalMs !== 0) {
      throw new HistoricalLoadError(
        "interval",
        `stream "${bucket.id}" has a ${gap}ms gap between ${previous.timestamp} and ${point.timestamp} (source ${point.source}), which is not a multiple of the declared intervalMs ${bucket.intervalMs}`,
        { stream: bucket.id, index: point.source }
      );
    }
  }
}

function finalizeBucket(
  bucket: Bucket,
  options: NormalizedOptions
): LoadedStream {
  const ordered =
    options.onOutOfOrder === "sort"
      ? [...bucket.points].sort((a, b) => a.timestamp - b.timestamp)
      : bucket.points;

  const kept: RawPoint[] = [];
  for (const point of ordered) {
    const previous = kept[kept.length - 1];
    if (previous === undefined) {
      kept.push(point);
      continue;
    }
    if (point.timestamp < previous.timestamp) {
      throw new HistoricalLoadError(
        "out-of-order",
        `stream "${bucket.id}" timestamp ${point.timestamp} (source ${point.source}) precedes ${previous.timestamp}; set onOutOfOrder: "sort" to sort instead`,
        { stream: bucket.id, index: point.source }
      );
    }
    if (point.timestamp === previous.timestamp) {
      if (options.onDuplicate === "reject") {
        throw new HistoricalLoadError(
          "duplicate",
          `stream "${bucket.id}" has duplicate timestamp ${point.timestamp} (source ${point.source}); set onDuplicate to "first" or "last" to resolve`,
          { stream: bucket.id, index: point.source }
        );
      }
      if (options.onDuplicate === "last") {
        kept[kept.length - 1] = point;
      }
      continue;
    }
    kept.push(point);
  }

  assertCadence(bucket, kept);

  const entries: TimeSeriesEntry[] = kept.map((point) => ({
    timestampMs: point.timestamp,
    value: point.value,
  }));

  return {
    id: bucket.id,
    asset: bucket.asset,
    kind: bucket.kind,
    series: TimeSeries.from(entries, {
      intervalMs: bucket.intervalMs,
      scale: bucket.scale,
    }),
  };
}

/**
 * Loads historical price/rate data into time series.
 *
 * Multiple assets and rate streams are loaded in one pass; the returned record
 * is keyed by stream id (`"<kind>:<asset>"` for row-sourced streams, the map
 * key for the map form). Throws {@link HistoricalLoadError} on any rejected
 * input, with a stable `code`.
 */
export function loadHistoricalSeries(
  input: HistoricalInput,
  options: LoadHistoricalOptions
): Record<string, LoadedStream> {
  const normalized = normalizeOptions(options);
  const buckets = new Map<string, Bucket>();

  if (isStreamMap(input)) {
    collectStreams(input.streams, normalized, buckets);
  } else if (isRowInput(input)) {
    collectRows(input.rows, normalized, buckets);
  } else if (Array.isArray(input)) {
    collectRows(input as readonly HistoricalRow[], normalized, buckets);
  } else {
    throw new HistoricalLoadError(
      "malformed-input",
      "input must be an array of rows, { rows }, or { streams }"
    );
  }

  const loaded: Record<string, LoadedStream> = {};
  for (const bucket of buckets.values()) {
    loaded[bucket.id] = finalizeBucket(bucket, normalized);
  }
  return loaded;
}

/**
 * Serialises a loaded stream back into row form at full scale. Feeding the
 * result back through {@link loadHistoricalSeries} with the same scale and
 * interval reproduces every value exactly (see historical-loader.test.ts).
 */
export function seriesToRows(stream: LoadedStream): HistoricalRow[] {
  return stream.series.points.map((point) => {
    const row: HistoricalRow = {
      asset: stream.asset,
      timestamp: point.timestampMs,
      kind: stream.kind,
    };
    if (stream.kind === "price") {
      row.price = point.value.toString();
    } else {
      row.rate = point.value.toString();
    }
    return row;
  });
}
