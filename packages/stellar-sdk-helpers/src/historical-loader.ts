// Historical price and rate ingestion (#865).
//
// Turns recorded market data into the {@link TimeSeries} structure a backtest
// replays, with no live network dependency and no floating-point step. A
// loaded series is already time-ordered and already fixed-point, so it feeds a
// backtest directly (see `TimeSeries.points`).
//
// ── Documented input format ────────────────────────────────────────────────
//
// Two equivalent JSON shapes are accepted by {@link loadHistoricalSeries}:
//
// 1. Row form — an array of rows (or `{ rows: [...] }`). Each row names an
//    `asset`, an observation `timestamp`, and at least one of `price` / `rate`:
//
//      [
//        { "asset": "USDC", "timestamp": 1710000000000, "price": "0.9999" },
//        { "asset": "USDC", "timestamp": "2024-03-09T16:00:00Z", "price": "1.0001" },
//        { "asset": "blend:USDC", "timestamp": 1710000000000, "rate": "0.0525" }
//      ]
//
//    A row with both `price` and `rate` contributes one point to each stream.
//    An explicit `kind: "price" | "rate"` selects exactly one field and ignores
//    the other (and is an error when that field is missing).
//
// 2. Multi-stream map form — `{ streams: { [streamId]: { asset, kind,
//    precision?, points: [{ timestamp, value }] } } }`. The map key becomes the
//    series id, which allows several streams over the same asset (e.g. two
//    protocols' rates) to be kept distinct.
//
// `timestamp` is epoch milliseconds as an integer, or an ISO-8601 string
// parsed with `Date.parse`. `price` / `rate` / `value` are decimal strings
// (preferred, exact) or JSON numbers; a value with more decimal places than the
// configured precision is rejected rather than rounded.
//
// ── Documented ordering and duplicate rule ─────────────────────────────────
//
// Within each stream, timestamps must be strictly increasing.
//   * Out-of-order (a timestamp strictly before the previous one) is governed
//     by `onOutOfOrder`: `"reject"` (default) throws a HistoricalLoadError with
//     code `"out-of-order"`; `"sort"` stably sorts the stream ascending first.
//   * Duplicate (a timestamp equal to the previous one) is governed by
//     `onDuplicate`: `"reject"` (default) throws with code `"duplicate"`;
//     `"first"` keeps the first observation; `"last"` keeps the last one.
//
// These rules are enforced by the loader, so every returned TimeSeries is
// guaranteed ordered and duplicate-free.

import {
  FixedPoint,
  TimeSeries,
  assertPrecision,
  type StreamKind,
} from "./time-series";

/** Default decimal places; matches the 7-decimal stroop scale used elsewhere. */
export const DEFAULT_HISTORICAL_PRECISION = 7;

export type HistoricalValue = string | number;

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
  /** Per-stream precision override; defaults to the loader's precision. */
  precision?: number;
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
  /** Decimal places for every loaded value. Default 7. */
  precision?: number;
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
  | "precision"
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

interface NormalizedOptions {
  precision: number;
  onOutOfOrder: OutOfOrderPolicy;
  onDuplicate: DuplicatePolicy;
  onMalformed: MalformedPolicy;
}

interface RawPoint {
  timestamp: number;
  value: FixedPoint;
  /** Index of the source row/point, for error messages. */
  source: number;
}

interface Bucket {
  id: string;
  asset: string;
  kind: StreamKind;
  precision: number;
  points: RawPoint[];
}

// Parse failures that `onMalformed: "skip"` may drop; ordering and duplicate
// violations are structural errors and always throw.
const SKIPPABLE: ReadonlySet<HistoricalLoadErrorCode> = new Set([
  "malformed-input",
  "invalid-timestamp",
  "invalid-value",
]);

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

function resolvePrecision(value: number | undefined): number {
  const precision = value ?? DEFAULT_HISTORICAL_PRECISION;
  try {
    assertPrecision(precision);
  } catch (err) {
    throw new HistoricalLoadError(
      "precision",
      err instanceof Error ? err.message : String(err)
    );
  }
  return precision;
}

function normalizeOptions(options: LoadHistoricalOptions): NormalizedOptions {
  return {
    precision: resolvePrecision(options.precision),
    onOutOfOrder: options.onOutOfOrder ?? "reject",
    onDuplicate: options.onDuplicate ?? "reject",
    onMalformed: options.onMalformed ?? "reject",
  };
}

function parseTimestamp(
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
  precision: number,
  details: { stream?: string; index?: number }
): FixedPoint {
  try {
    return FixedPoint.from(raw, precision);
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

function bucketFor(
  buckets: Map<string, Bucket>,
  id: string,
  asset: string,
  kind: StreamKind,
  precision: number
): Bucket {
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { id, asset, kind, precision, points: [] };
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

  let kinds: StreamKind[];
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
    kinds = [row.kind];
  } else {
    kinds = [];
    if (hasValue(row.price)) kinds.push("price");
    if (hasValue(row.rate)) kinds.push("rate");
    if (kinds.length === 0) {
      throw new HistoricalLoadError(
        "malformed-input",
        `row ${index} must provide at least one of "price" or "rate"`,
        { stream: asset, index }
      );
    }
  }

  // Parse every value this row contributes before touching a bucket, so a row
  // that fails on its second field doesn't leave a partial point behind.
  const parsed: Array<{ kind: StreamKind; id: string; value: FixedPoint }> = [];
  for (const kind of kinds) {
    const raw = kind === "price" ? row.price : row.rate;
    if (!hasValue(raw)) {
      // Only reachable when no explicit kind narrows the fields; the other
      // field must have been present for `kinds` to include this one.
      continue;
    }
    const id = `${kind}:${asset}`;
    parsed.push({
      kind,
      id,
      value: parseValue(raw, options.precision, { stream: id, index }),
    });
  }
  for (const point of parsed) {
    bucketFor(buckets, point.id, asset, point.kind, options.precision).points.push({
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
      if (
        options.onMalformed === "skip" &&
        err instanceof HistoricalLoadError &&
        SKIPPABLE.has(err.code)
      ) {
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
        resolvePrecision(stream.precision ?? options.precision)
      );
    } catch (err) {
      if (
        options.onMalformed === "skip" &&
        err instanceof HistoricalLoadError &&
        SKIPPABLE.has(err.code)
      ) {
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
          value: parseValue(point.value, bucket.precision, { stream: id, index }),
          source: index,
        });
      } catch (err) {
        if (
          options.onMalformed === "skip" &&
          err instanceof HistoricalLoadError &&
          SKIPPABLE.has(err.code)
        ) {
          continue;
        }
        throw err;
      }
    }
  }
}

function finalizeBucket(
  bucket: Bucket,
  options: NormalizedOptions
): TimeSeries {
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

  return new TimeSeries(
    bucket.id,
    bucket.asset,
    bucket.kind,
    bucket.precision,
    kept.map((point) => ({ timestamp: point.timestamp, value: point.value }))
  );
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
  options: LoadHistoricalOptions = {}
): Record<string, TimeSeries> {
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

  const series: Record<string, TimeSeries> = {};
  for (const bucket of buckets.values()) {
    series[bucket.id] = finalizeBucket(bucket, normalized);
  }
  return series;
}

/**
 * Serialises a loaded series back into row form at full precision. Feeding the
 * result back through {@link loadHistoricalSeries} at the same precision
 * reproduces every value exactly (see historical-loader.test.ts).
 */
export function seriesToRows(series: TimeSeries): HistoricalRow[] {
  return series.points.map((point) => {
    const row: HistoricalRow = {
      asset: series.asset,
      timestamp: point.timestamp,
      kind: series.kind,
    };
    if (series.kind === "price") {
      row.price = point.value.toFixedString();
    } else {
      row.rate = point.value.toFixedString();
    }
    return row;
  });
}
