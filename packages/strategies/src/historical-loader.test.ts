import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORICAL_SCALE,
  HistoricalLoadError,
  MAX_HISTORICAL_SCALE,
  loadHistoricalSeries,
  seriesToRows,
  type HistoricalInput,
  type HistoricalLoadErrorCode,
  type LoadHistoricalOptions,
  type LoadedStream,
} from "./historical-loader";

// Most cases use small integer timestamps, so a 1ms grid keeps the cadence
// assertion out of the way of what they are actually testing.
const GRID: Pick<LoadHistoricalOptions, "intervalMs"> = { intervalMs: 1 };

function load(
  input: unknown,
  options: Partial<LoadHistoricalOptions> = {}
): Record<string, LoadedStream> {
  return loadHistoricalSeries(input as HistoricalInput, {
    ...GRID,
    ...options,
  });
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
    expect(usdc.kind).toBe("price");
    expect(usdc.asset).toBe("USDC");
    expect(usdc.series.scale).toBe(DEFAULT_HISTORICAL_SCALE);
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
          scale: 2,
          points: [{ timestamp: 5, value: "7.25" }],
        },
      },
    });
    expect(Object.keys(result).sort()).toEqual(["blend-usdc", "defindex-usdc"]);
    expect(result["blend-usdc"]!.series.scale).toBe(DEFAULT_HISTORICAL_SCALE);
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
});

describe("loadHistoricalSeries - decimal values", () => {
  it("expands scientific notation exactly", () => {
    expect(
      load([{ asset: "A", timestamp: 1, price: "1.5e-3" }])[
        "price:A"
      ]!.series.points[0]!.value.toString()
    ).toBe("0.0015000");
    expect(
      load([{ asset: "A", timestamp: 1, price: "1.5e3" }], { scale: 2 })[
        "price:A"
      ]!.series.points[0]!.value.toString()
    ).toBe("1500.00");
    expect(
      load([{ asset: "A", timestamp: 1, price: "1e-8" }], { scale: 8 })[
        "price:A"
      ]!.series.points[0]!.value.toString()
    ).toBe("0.00000001");
  });

  it("accepts trailing zeros beyond the scale but rejects real overflow", () => {
    const padded = load([{ asset: "A", timestamp: 1, price: "1.230000000" }]);
    expect(padded["price:A"]!.series.points[0]!.value.toString()).toBe(
      "1.2300000"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "0.00000001" }]),
      "invalid-value"
    );
  });

  it("handles negatives and zero", () => {
    const result = load([
      { asset: "A", timestamp: 1, price: "-0.5" },
      { asset: "A", timestamp: 2, price: "0" },
    ]);
    const points = result["price:A"]!.series.points;
    expect(points[0]!.value.toString()).toBe("-0.5000000");
    expect(points[1]!.value.isZero()).toBe(true);
  });

  it("reads a JSON number as its exact shortest representation", () => {
    const result = load([{ asset: "A", timestamp: 1, price: 0.1 }]);
    expect(result["price:A"]!.series.points[0]!.value.toString()).toBe(
      "0.1000000"
    );
  });

  it("rejects a number whose float representation carries hidden digits", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: 0.1 + 0.2 }]),
      "invalid-value"
    );
  });

  it("rejects an exponent too large to materialise", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1e100000" }]),
      "invalid-value"
    );
  });

  it("holds every value at the configured scale", () => {
    const result = load([{ asset: "A", timestamp: 1, price: "1.23456789" }], {
      scale: 8,
    });
    const value = result["price:A"]!.series.points[0]!.value;
    expect(value.raw).toBe(123_456_789n);
    expect(value.scale).toBe(8);
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
    const points = result["price:A"]!.series.points;
    expect(points.map((p) => p.timestampMs)).toEqual([1, 2, 3]);
    expect(points.map((p) => p.value.toString())).toEqual([
      "1.0000000",
      "2.0000000",
      "3.0000000",
    ]);
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
    const rows = [
      { asset: "A", timestamp: 1, price: "1" },
      { asset: "A", timestamp: 1, price: "2" },
    ];
    const first = load(rows, { onDuplicate: "first" });
    expect(first["price:A"]!.series.size).toBe(1);
    expect(first["price:A"]!.series.points[0]!.value.toString()).toBe(
      "1.0000000"
    );

    const last = load(rows, { onDuplicate: "last" });
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

  it("rejects an invalid scale option", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1" }], { scale: -1 }),
      "scale"
    );
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1" }], { scale: 1.5 }),
      "scale"
    );
    expectCode(
      () =>
        load([{ asset: "A", timestamp: 1, price: "1" }], {
          scale: MAX_HISTORICAL_SCALE + 1,
        }),
      "scale"
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

describe("loadHistoricalSeries - cadence", () => {
  it("requires intervalMs", () => {
    expectCode(
      () =>
        loadHistoricalSeries(
          [{ asset: "A", timestamp: 1, price: "1" }],
          {} as LoadHistoricalOptions
        ),
      "interval"
    );
  });

  it("rejects a null options object", () => {
    expectCode(
      () =>
        loadHistoricalSeries(
          [{ asset: "A", timestamp: 1, price: "1" }],
          null as unknown as LoadHistoricalOptions
        ),
      "interval"
    );
  });

  it("rejects an intervalMs that is not a positive safe integer", () => {
    const rows = [{ asset: "A", timestamp: 1, price: "1" }];
    expectCode(() => load(rows, { intervalMs: 0 }), "interval");
    expectCode(() => load(rows, { intervalMs: -5 }), "interval");
    expectCode(() => load(rows, { intervalMs: 1.5 }), "interval");
    expectCode(
      () => load(rows, { intervalMs: Number.MAX_SAFE_INTEGER + 2 }),
      "interval"
    );
  });

  it("rejects a gap that is not a whole number of intervals", () => {
    expectCode(
      () =>
        load(
          [
            { asset: "A", timestamp: 0, price: "1" },
            { asset: "A", timestamp: 1_500, price: "2" },
          ],
          { intervalMs: 1_000 }
        ),
      "interval"
    );
  });

  it("accepts a gap spanning several whole intervals", () => {
    const result = load(
      [
        { asset: "A", timestamp: 0, price: "1" },
        { asset: "A", timestamp: 3_000, price: "2" },
      ],
      { intervalMs: 1_000 }
    );
    expect(result["price:A"]!.series.intervalMs).toBe(1_000);
    expect(result["price:A"]!.series.size).toBe(2);
  });

  it("validates each stream against its own intervalMs override", () => {
    const stream = (points: Array<{ timestamp: number; value: string }>) => ({
      streams: {
        s: { asset: "A", kind: "price" as const, intervalMs: 1_000, points },
      },
    });
    const ok = load(
      stream([
        { timestamp: 0, value: "1" },
        { timestamp: 2_000, value: "2" },
      ])
    );
    expect(ok["s"]!.series.intervalMs).toBe(1_000);
    expectCode(
      () =>
        load(
          stream([
            { timestamp: 0, value: "1" },
            { timestamp: 1_500, value: "2" },
          ])
        ),
      "interval"
    );
  });

  it("rejects a negative timestamp", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: -1, price: "1" }]),
      "invalid-timestamp"
    );
  });

  it("produces a series a backtest can replay at the clock's step", () => {
    const loaded = load(
      [
        { asset: "USDC", timestamp: 0, price: "1" },
        { asset: "USDC", timestamp: 60_000, price: "2" },
        { asset: "USDC", timestamp: 120_000, price: "3" },
      ],
      { intervalMs: 60_000 }
    );
    const series = loaded["price:USDC"]!.series;
    expect(series.intervalMs).toBe(60_000);

    const stepped = series.resample(300_000, { aggregation: "last" });
    expect(stepped.points.map((p) => p.timestampMs)).toEqual([0]);
    expect(stepped.points[0]!.value.toString()).toBe("3.0000000");
  });
});

describe("loadHistoricalSeries - lossless round-trip", () => {
  it("reproduces every source value at the configured scale", () => {
    const scale = 8;
    const rows = [
      { asset: "USDC", timestamp: 1, price: "1.23456789" },
      { asset: "USDC", timestamp: 2, price: "0.00000001" },
      { asset: "pool:blend", timestamp: 1, rate: "5.25" },
    ];
    const loaded = load(rows, { scale });

    expect(loaded["price:USDC"]!.series.points[0]!.value.raw).toBe(
      123_456_789n
    );
    expect(loaded["price:USDC"]!.series.points[1]!.value.raw).toBe(1n);
    expect(loaded["rate:pool:blend"]!.series.points[0]!.value.raw).toBe(
      525_000_000n
    );

    // Serialise back to rows at full scale and reload: the scaled bigints must
    // be identical.
    const reloaded = load(
      Object.values(loaded).flatMap((stream) => seriesToRows(stream)),
      { scale }
    );
    for (const [id, stream] of Object.entries(loaded)) {
      const again = reloaded[id]!;
      expect(again.series.size).toBe(stream.series.size);
      stream.series.points.forEach((point, index) => {
        expect(again.series.points[index]!.timestampMs).toBe(point.timestampMs);
        expect(again.series.points[index]!.value.raw).toBe(point.value.raw);
      });
    }
  });

  it("round-trips scientific-notation source values", () => {
    const loaded = load([{ asset: "A", timestamp: 1, price: "1e-8" }], {
      scale: 8,
    });
    expect(loaded["price:A"]!.series.points[0]!.value.toString()).toBe(
      "0.00000001"
    );
    const rows = seriesToRows(loaded["price:A"]!);
    expect(rows).toEqual([
      { asset: "A", timestamp: 1, kind: "price", price: "0.00000001" },
    ]);
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

  it("still throws a scale error under onMalformed: 'skip'", () => {
    expectCode(
      () => load(mapOf({ scale: -1 }), { onMalformed: "skip" }),
      "scale"
    );
  });

  it("still throws a cadence error under onMalformed: 'skip'", () => {
    expectCode(
      () =>
        load(
          mapOf({
            intervalMs: 1_000,
            points: [
              { timestamp: 0, value: "1" },
              { timestamp: 1_500, value: "2" },
            ],
          }),
          { onMalformed: "skip" }
        ),
      "interval"
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
