import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import { TimeSeries } from "./time-series";
import {
  DEFAULT_HISTORICAL_PRECISION,
  MAX_HISTORICAL_PRECISION,
  HistoricalLoadError,
  loadHistoricalSeries,
  seriesToRows,
  type HistoricalInput,
  type HistoricalLoadErrorCode,
  type LoadedSeries,
  type LoadHistoricalOptions,
} from "./historical-loader";

function load(
  input: unknown,
  options: LoadHistoricalOptions = {}
): Record<string, LoadedSeries> {
  return loadHistoricalSeries(input as HistoricalInput, options);
}

function expectCode(fn: () => unknown, code: HistoricalLoadErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HistoricalLoadError);
  expect((thrown as HistoricalLoadError).code).toBe(code);
}

describe("loadHistoricalSeries - parsing", () => {
  it("loads price and rate streams from rows in one pass", () => {
    const result = load([
      { asset: "USDC", timestamp: 1_000, price: "0.9999" },
      { asset: "USDC", timestamp: 2_000, price: "1.0001" },
      { asset: "blend:USDC", timestamp: 1_000, rate: "0.0525" },
    ]);
    expect(Object.keys(result).sort()).toEqual([
      "price:USDC",
      "rate:blend:USDC",
    ]);
    const usdc = result["price:USDC"]!;
    expect(usdc.id).toBe("price:USDC");
    expect(usdc.asset).toBe("USDC");
    expect(usdc.kind).toBe("price");
    expect(usdc.series.scale).toBe(DEFAULT_HISTORICAL_PRECISION);
    expect(usdc.series.points.map((p) => p.timestampMs)).toEqual([
      1_000, 2_000,
    ]);
    expect(usdc.series.points[0]!.value.toString()).toBe("0.9999000");
    expect(result["rate:blend:USDC"]!.series.points[0]!.value.toString()).toBe(
      "0.0525000"
    );
  });

  it("accepts ISO-8601 timestamps", () => {
    const result = load([
      { asset: "USDC", timestamp: "2024-03-09T16:00:00Z", price: "1" },
    ]);
    expect(result["price:USDC"]!.series.points[0]!.timestampMs).toBe(
      1_710_000_000_000
    );
  });

  it("contributes a row with both price and rate to both streams", () => {
    const result = load([{ asset: "A", timestamp: 1, price: "1", rate: "2" }]);
    expect(Object.keys(result).sort()).toEqual(["price:A", "rate:A"]);
  });

  it("honours an explicit kind and ignores the other field", () => {
    const result = load([
      { asset: "A", timestamp: 1, kind: "rate", price: "9", rate: "2" },
    ]);
    expect(Object.keys(result)).toEqual(["rate:A"]);
    expect(result["rate:A"]!.series.points[0]!.value.toString()).toBe(
      "2.0000000"
    );
  });

  it("loads the multi-stream map form and keeps stream ids distinct", () => {
    const result = load({
      streams: {
        "blend-usdc": {
          asset: "USDC",
          kind: "rate",
          points: [{ timestamp: 2, value: "3.1" }],
        },
        "defindex-usdc": {
          asset: "USDC",
          kind: "rate",
          precision: 2,
          points: [{ timestamp: 5, value: "7.25" }],
        },
      },
    });
    expect(Object.keys(result).sort()).toEqual(["blend-usdc", "defindex-usdc"]);
    expect(result["blend-usdc"]!.series.scale).toBe(
      DEFAULT_HISTORICAL_PRECISION
    );
    expect(result["defindex-usdc"]!.series.scale).toBe(2);
    expect(result["defindex-usdc"]!.series.points[0]!.value.toString()).toBe(
      "7.25"
    );
  });

  it("accepts the { rows } wrapper", () => {
    const result = load({
      rows: [{ asset: "A", timestamp: 1, price: "1.5" }],
    });
    expect(result["price:A"]!.series.size).toBe(1);
  });

  it("supports multiple assets in one pass", () => {
    const result = load([
      { asset: "A", timestamp: 1, price: "1" },
      { asset: "B", timestamp: 1, price: "2" },
      { asset: "C", timestamp: 1, price: "3" },
    ]);
    expect(Object.keys(result).sort()).toEqual([
      "price:A",
      "price:B",
      "price:C",
    ]);
  });

  it("parses scientific notation and trailing zeros exactly", () => {
    const result = load(
      [
        { asset: "A", timestamp: 1, price: "1.5e-3" },
        { asset: "A", timestamp: 2, price: "1.230000000" },
      ],
      { precision: 7 }
    );
    expect(result["price:A"]!.series.points[0]!.value.toString()).toBe(
      "0.0015000"
    );
    expect(result["price:A"]!.series.points[1]!.value.toBigInt()).toBe(
      12_300_000n
    );
    expect(result["price:A"]!.series.points[1]!.value.toString()).toBe(
      "1.2300000"
    );
  });

  it("accepts a JSON number value and scales it exactly", () => {
    const result = load([{ asset: "A", timestamp: 1, price: 0.1 }], {
      precision: 7,
    });
    expect(result["price:A"]!.series.points[0]!.value.toBigInt()).toBe(
      1_000_000n
    );
    expect(result["price:A"]!.series.points[0]!.value.toString()).toBe(
      "0.1000000"
    );
  });

  it("parses a negative value", () => {
    const result = load([{ asset: "A", timestamp: 1, price: "-0.5" }]);
    expect(result["price:A"]!.series.points[0]!.value.toString()).toBe(
      "-0.5000000"
    );
  });
});

describe("loadHistoricalSeries - ordering and duplicates", () => {
  it("rejects out-of-order timestamps by default", () => {
    expectCode(
      () =>
        load([
          { asset: "A", timestamp: 2, price: "1" },
          { asset: "A", timestamp: 1, price: "1" },
        ]),
      "out-of-order"
    );
  });

  it("sorts ascending under onOutOfOrder: 'sort'", () => {
    const result = load(
      [
        { asset: "A", timestamp: 3, price: "3" },
        { asset: "A", timestamp: 1, price: "1" },
        { asset: "A", timestamp: 2, price: "2" },
      ],
      { onOutOfOrder: "sort" }
    );
    expect(result["price:A"]!.series.points.map((p) => p.timestampMs)).toEqual([
      1, 2, 3,
    ]);
    expect(
      result["price:A"]!.series.points.map((p) => p.value.toString())
    ).toEqual(["1.0000000", "2.0000000", "3.0000000"]);
  });

  it("rejects duplicate timestamps by default", () => {
    expectCode(
      () =>
        load([
          { asset: "A", timestamp: 1, price: "1" },
          { asset: "A", timestamp: 1, price: "2" },
        ]),
      "duplicate"
    );
  });

  it("keeps first/last on duplicates when configured", () => {
    const first = load(
      [
        { asset: "A", timestamp: 1, price: "1" },
        { asset: "A", timestamp: 1, price: "2" },
      ],
      { onDuplicate: "first" }
    );
    expect(first["price:A"]!.series.size).toBe(1);
    expect(first["price:A"]!.series.points[0]!.value.toString()).toBe(
      "1.0000000"
    );

    const last = load(
      [
        { asset: "A", timestamp: 1, price: "1" },
        { asset: "A", timestamp: 1, price: "2" },
      ],
      { onDuplicate: "last" }
    );
    expect(last["price:A"]!.series.size).toBe(1);
    expect(last["price:A"]!.series.points[0]!.value.toString()).toBe(
      "2.0000000"
    );
  });

  it("still rejects duplicates after sorting", () => {
    expectCode(
      () =>
        load(
          [
            { asset: "A", timestamp: 2, price: "1" },
            { asset: "A", timestamp: 1, price: "1" },
            { asset: "A", timestamp: 1, price: "2" },
          ],
          { onOutOfOrder: "sort" }
        ),
      "duplicate"
    );
  });
});

describe("loadHistoricalSeries - malformed input", () => {
  it("rejects a missing asset", () => {
    expectCode(() => load([{ timestamp: 1, price: "1" }]), "malformed-input");
  });

  it("rejects a row with neither price nor rate", () => {
    expectCode(() => load([{ asset: "A", timestamp: 1 }]), "malformed-input");
  });

  it("rejects an explicit kind whose field is missing", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, kind: "rate", price: "1" }]),
      "malformed-input"
    );
  });

  it("rejects an invalid timestamp", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: "not-a-date", price: "1" }]),
      "invalid-timestamp"
    );
  });

  it("rejects an invalid value", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "abc" }]),
      "invalid-value"
    );
  });

  it("rejects a value with too many decimal places", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "0.00000001" }]),
      "invalid-value"
    );
  });

  it("rejects a decimal exponent outside the supported range", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1e100000" }]),
      "invalid-value"
    );
  });

  it("rejects an invalid precision option", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1" }], { precision: -1 }),
      "precision"
    );
    expectCode(
      () =>
        load([{ asset: "A", timestamp: 1, price: "1" }], {
          precision: MAX_HISTORICAL_PRECISION + 1,
        }),
      "precision"
    );
  });

  it("rejects a non-input shape", () => {
    expectCode(() => load(42), "malformed-input");
  });

  it("skips malformed rows under onMalformed: 'skip'", () => {
    const result = load(
      [
        { asset: "A", timestamp: 1, price: "1.5" },
        { asset: "", timestamp: 2, price: "1" },
        { asset: "A", timestamp: 2, price: "oops" },
        { asset: "A", timestamp: 3, price: "2.5" },
      ],
      { onMalformed: "skip" }
    );
    expect(result["price:A"]!.series.points.map((p) => p.timestampMs)).toEqual([
      1, 3,
    ]);
  });

  it("skips only the malformed point in the map form", () => {
    const result = load(
      {
        streams: {
          s: {
            asset: "A",
            kind: "price",
            points: [
              { timestamp: 1, value: "1" },
              { timestamp: 2, value: "oops" },
              { timestamp: 3, value: "3" },
            ],
          },
        },
      },
      { onMalformed: "skip" }
    );
    expect(result["s"]!.series.points.map((p) => p.timestampMs)).toEqual([
      1, 3,
    ]);
  });

  it("loads no point from a malformed both-fields row under skip", () => {
    const result = load(
      [
        { asset: "A", timestamp: 1, price: "1", rate: "bogus" },
        { asset: "A", timestamp: 2, price: "2", rate: "2" },
      ],
      { onMalformed: "skip" }
    );
    expect(result["price:A"]!.series.points.map((p) => p.timestampMs)).toEqual([
      2,
    ]);
    expect(result["rate:A"]!.series.points.map((p) => p.timestampMs)).toEqual([
      2,
    ]);
  });
});

describe("loadHistoricalSeries - lossless round-trip", () => {
  it("reproduces every source value at the configured precision", () => {
    const precision = 8;
    const rows = [
      { asset: "USDC", timestamp: 1, price: "1.23456789" },
      { asset: "USDC", timestamp: 2, price: "0.00000001" },
      { asset: "pool:blend", timestamp: 1, rate: "5.25" },
    ];
    const loaded = load(rows, { precision });

    expect(
      loaded["price:USDC"]!.series.points[0]!.value.eq(
        Decimal.fromString("1.23456789", precision)
      )
    ).toBe(true);
    expect(
      loaded["price:USDC"]!.series.points[1]!.value.eq(
        Decimal.fromString("0.00000001", precision)
      )
    ).toBe(true);
    expect(
      loaded["rate:pool:blend"]!.series.points[0]!.value.eq(
        Decimal.fromString("5.25", precision)
      )
    ).toBe(true);

    // Serialise back to rows at fixed precision and reload: the scaled bigints
    // must be byte-for-byte identical.
    const reloaded = load(
      Object.values(loaded).flatMap((series) => seriesToRows(series)),
      { precision }
    );
    for (const [id, series] of Object.entries(loaded)) {
      const again = reloaded[id]!;
      expect(again.series.size).toBe(series.series.size);
      series.series.points.forEach((point, index) => {
        expect(again.series.points[index]!.timestampMs).toBe(point.timestampMs);
        expect(again.series.points[index]!.value.eq(point.value)).toBe(true);
      });
    }
  });

  it("round-trips scientific-notation source values", () => {
    const loaded = load([{ asset: "A", timestamp: 1, price: "1e-8" }], {
      precision: 8,
    });
    expect(loaded["price:A"]!.series.points[0]!.value.toString()).toBe(
      "0.00000001"
    );
  });
});

describe("loadHistoricalSeries - timestamp validation", () => {
  it("rejects a numeric timestamp that is not a safe integer", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1.5, price: "1" }]),
      "invalid-timestamp"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: Number.NaN, price: "1" }]),
      "invalid-timestamp"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: Number.MAX_VALUE, price: "1" }]),
      "invalid-timestamp"
    );
  });

  it("rejects a negative timestamp", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: -1, price: "1" }]),
      "invalid-timestamp"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: "-5", price: "1" }]),
      "invalid-timestamp"
    );
    expectCode(
      () =>
        load([{ asset: "A", timestamp: "1969-12-31T23:59:59Z", price: "1" }]),
      "invalid-timestamp"
    );
  });

  it("rejects a timestamp that is neither a number nor a non-empty string", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: null, price: "1" }]),
      "malformed-input"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: true, price: "1" }]),
      "malformed-input"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: "   ", price: "1" }]),
      "malformed-input"
    );
  });

  it("parses an epoch-millisecond string timestamp, whitespace included", () => {
    const result = load([
      { asset: "A", timestamp: "1710000000000", price: "1" },
      { asset: "A", timestamp: " 1710000000001 ", price: "1" },
    ]);
    expect(result["price:A"]!.series.points.map((p) => p.timestampMs)).toEqual([
      1_710_000_000_000, 1_710_000_000_001,
    ]);
  });

  it("rejects a numeric string timestamp outside the safe integer range", () => {
    expectCode(
      () =>
        load([{ asset: "A", timestamp: "99999999999999999999", price: "1" }]),
      "invalid-timestamp"
    );
  });

  it("rejects rows that are not objects", () => {
    expectCode(() => load([null]), "malformed-input");
    expectCode(() => load(["not-a-row"]), "malformed-input");
  });

  it("rejects a row with an unrecognised kind", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1", kind: "yield" }]),
      "malformed-input"
    );
  });
});

describe("loadHistoricalSeries - stream map validation", () => {
  const mapOf = (over: Record<string, unknown>) => ({
    streams: {
      s: {
        asset: "A",
        kind: "price",
        points: [{ timestamp: 1, value: "1" }],
        ...over,
      },
    },
  });

  it("rejects an empty stream id", () => {
    expectCode(
      () =>
        load({ streams: { "": { asset: "A", kind: "price", points: [] } } }),
      "malformed-input"
    );
  });

  it("rejects a stream that is not an object", () => {
    expectCode(() => load({ streams: { s: null } }), "malformed-input");
    expectCode(() => load({ streams: { s: "nope" } }), "malformed-input");
  });

  it("rejects a stream without a usable asset", () => {
    expectCode(() => load(mapOf({ asset: "" })), "malformed-input");
    expectCode(() => load(mapOf({ asset: 7 })), "malformed-input");
  });

  it("rejects a stream with an unrecognised kind", () => {
    expectCode(() => load(mapOf({ kind: "yield" })), "malformed-input");
  });

  it("rejects a stream whose points are not an array", () => {
    expectCode(() => load(mapOf({ points: "nope" })), "malformed-input");
  });

  it("drops only the malformed stream under onMalformed: 'skip'", () => {
    const result = load(
      {
        streams: {
          bad: null,
          good: {
            asset: "A",
            kind: "price",
            points: [{ timestamp: 1, value: "1" }],
          },
        },
      },
      { onMalformed: "skip" }
    );
    expect(Object.keys(result)).toEqual(["good"]);
  });

  it("still throws a precision error under onMalformed: 'skip'", () => {
    expectCode(
      () => load(mapOf({ precision: -1 }), { onMalformed: "skip" }),
      "precision"
    );
  });

  it("rejects points that are not objects", () => {
    expectCode(() => load(mapOf({ points: [null] })), "malformed-input");
    expectCode(() => load(mapOf({ points: ["nope"] })), "malformed-input");
  });

  it("rejects a point with no value", () => {
    expectCode(
      () => load(mapOf({ points: [{ timestamp: 1 }] })),
      "malformed-input"
    );
  });

  it("rethrows an unparsable point value unless skipping is enabled", () => {
    expectCode(
      () => load(mapOf({ points: [{ timestamp: 1, value: "oops" }] })),
      "invalid-value"
    );
  });
});

describe("loadHistoricalSeries - shared TimeSeries (#866)", () => {
  it("returns the shared TimeSeries holding Decimal values", () => {
    const result = load([{ asset: "A", timestamp: 0, price: "1.5" }]);
    const series = result["price:A"]!.series;
    expect(series).toBeInstanceOf(TimeSeries);
    expect(series.points[0]!.value).toBeInstanceOf(Decimal);
    expect(series.scale).toBe(DEFAULT_HISTORICAL_PRECISION);
  });

  it("infers the nominal interval from the gcd of the sample gaps", () => {
    const regular = load([
      { asset: "A", timestamp: 1_000, price: "1" },
      { asset: "A", timestamp: 2_000, price: "1" },
      { asset: "A", timestamp: 3_000, price: "1" },
    ]);
    expect(regular["price:A"]!.series.intervalMs).toBe(1_000);

    const mixed = load([
      { asset: "B", timestamp: 1_000, price: "1" },
      { asset: "B", timestamp: 1_500, price: "1" },
      { asset: "B", timestamp: 4_000, price: "1" },
    ]);
    expect(mixed["price:B"]!.series.intervalMs).toBe(500);
  });

  it("uses a 1ms interval for a stream with fewer than two points", () => {
    const single = load([{ asset: "A", timestamp: 5, price: "1" }]);
    expect(single["price:A"]!.series.intervalMs).toBe(1);

    const empty = load({
      streams: { s: { asset: "A", kind: "price", points: [] } },
    });
    expect(empty["s"]!.series.intervalMs).toBe(1);
    expect(empty["s"]!.series.size).toBe(0);
  });

  it("inherits atOrBefore lookup and resampling from the shared series", () => {
    const series = load([
      { asset: "A", timestamp: 1_000, price: "1" },
      { asset: "A", timestamp: 2_000, price: "3" },
    ])["price:A"]!.series;

    expect(series.atOrBefore(999)).toBeNull();
    expect(series.atOrBefore(1_999)!.timestampMs).toBe(1_000);
    expect(series.atOrBefore(2_000)!.value.toString()).toBe("3.0000000");

    const resampled = series.resample(2_000, { aggregation: "mean" });
    expect(resampled.intervalMs).toBe(2_000);
    expect(resampled.points.map((p) => p.timestampMs)).toEqual([0, 2_000]);
    expect(resampled.points[0]!.value.toString()).toBe("1.0000000");
    expect(resampled.points[1]!.value.toString()).toBe("3.0000000");
  });

  it("is immutable: resampling does not mutate the loaded series", () => {
    const series = load([
      { asset: "A", timestamp: 1_000, price: "1" },
      { asset: "A", timestamp: 2_000, price: "3" },
    ])["price:A"]!.series;

    const before = series.points.map((p) => p.value.toString());
    series.resample(1_000);
    expect(series.points.map((p) => p.value.toString())).toEqual(before);
    expect(series.size).toBe(2);
  });
});

describe("seriesToRows", () => {
  it("emits fixed-precision price and rate rows that reload exactly", () => {
    const loaded = load([
      { asset: "A", timestamp: 1, price: "1.5" },
      { asset: "A", timestamp: 2, rate: "2.25" },
    ]);
    const rows = [
      ...seriesToRows(loaded["price:A"]!),
      ...seriesToRows(loaded["rate:A"]!),
    ];
    expect(rows).toEqual([
      { asset: "A", timestamp: 1, kind: "price", price: "1.5000000" },
      { asset: "A", timestamp: 2, kind: "rate", rate: "2.2500000" },
    ]);
  });
});
