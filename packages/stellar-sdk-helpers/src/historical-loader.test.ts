import { describe, expect, it } from "vitest";
import { FixedPoint, MAX_FIXED_PRECISION, TimeSeries } from "./time-series";
import {
  DEFAULT_HISTORICAL_PRECISION,
  HistoricalLoadError,
  loadHistoricalSeries,
  seriesToRows,
  type HistoricalInput,
  type HistoricalLoadErrorCode,
  type LoadHistoricalOptions,
} from "./historical-loader";

function load(
  input: unknown,
  options: LoadHistoricalOptions = {}
): Record<string, TimeSeries> {
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

describe("FixedPoint", () => {
  it("parses a decimal string exactly and trims in toString", () => {
    const value = FixedPoint.from("1.2300000", 7);
    expect(value.toBigInt()).toBe(12_300_000n);
    expect(value.toString()).toBe("1.23");
  });

  it("formats to a fixed number of decimal places", () => {
    expect(FixedPoint.from("1.23", 7).toFixedString()).toBe("1.2300000");
    expect(FixedPoint.from("2", 7).toFixedString()).toBe("2.0000000");
    expect(FixedPoint.from(0.1, 7).toFixedString()).toBe("0.1000000");
  });

  it("handles scientific notation", () => {
    expect(FixedPoint.from("1.5e-3", 7).toFixedString()).toBe("0.0015000");
    expect(FixedPoint.from("1.5e3", 2).toFixedString()).toBe("1500.00");
  });

  it("accepts trailing zeros beyond the precision but rejects real overflow", () => {
    expect(FixedPoint.from("1.230000000", 7).toString()).toBe("1.23");
    expect(() => FixedPoint.from("0.00000001", 7)).toThrow(/decimal place/);
  });

  it("handles negatives and zero", () => {
    expect(FixedPoint.from("-0.5", 7).toFixedString()).toBe("-0.5000000");
    expect(FixedPoint.from("0", 7).isZero).toBe(true);
    expect(FixedPoint.from("0", 7).toString()).toBe("0");
  });

  it("does exact arithmetic on matching precisions", () => {
    const a = FixedPoint.from("1.5", 7);
    const b = FixedPoint.from("0.25", 7);
    expect(a.add(b).toFixedString()).toBe("1.7500000");
    expect(a.sub(b).toFixedString()).toBe("1.2500000");
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.equals(FixedPoint.fromScaled(15_000_000n, 7))).toBe(true);
    expect(a.negate().toFixedString()).toBe("-1.5000000");
  });

  it("refuses to combine different precisions", () => {
    expect(() =>
      FixedPoint.from("1", 7).add(FixedPoint.from("1", 8))
    ).toThrow(/different precision/);
  });

  it("validates the precision", () => {
    expect(() => FixedPoint.from("1", -1)).toThrow(RangeError);
    expect(() => FixedPoint.from("1", 1.5)).toThrow(RangeError);
    expect(() => FixedPoint.from("1", MAX_FIXED_PRECISION + 1)).toThrow(
      RangeError
    );
  });

  it("rejects non-decimal garbage", () => {
    expect(() => FixedPoint.from("not-a-number", 7)).toThrow(/invalid decimal/);
    expect(() => FixedPoint.from("", 7)).toThrow(/invalid decimal/);
  });
});

describe("TimeSeries", () => {
  it("exposes ordered points and lookups", () => {
    const series = new TimeSeries("price:A", "A", "price", 2, [
      { timestamp: 1, value: FixedPoint.from("1.00", 2) },
      { timestamp: 2, value: FixedPoint.from("2.50", 2) },
    ]);
    expect(series.length).toBe(2);
    expect(series.isEmpty).toBe(false);
    expect(series.first?.timestamp).toBe(1);
    expect(series.latest?.timestamp).toBe(2);
    expect(series.at(1)?.value.toString()).toBe("2.5");
    expect(series.valueAt(2)?.toString()).toBe("2.5");
    expect(series.valueAt(99)).toBeUndefined();
    expect([...series].map((p) => p.timestamp)).toEqual([1, 2]);
  });

  it("is empty by default and serialises losslessly", () => {
    const empty = TimeSeries.empty("rate:p", "p", "rate", 3);
    expect(empty.isEmpty).toBe(true);
    expect(empty.first).toBeUndefined();

    const series = new TimeSeries("rate:p", "p", "rate", 6, [
      { timestamp: 10, value: FixedPoint.from("5.25", 6) },
    ]);
    expect(series.toJSON()).toEqual({
      id: "rate:p",
      asset: "p",
      kind: "rate",
      precision: 6,
      points: [{ timestamp: 10, value: "5.250000" }],
    });
  });
});

describe("loadHistoricalSeries - parsing", () => {
  it("loads price and rate streams from rows in one pass", () => {
    const result = load([
      { asset: "USDC", timestamp: 1_000, price: "0.9999" },
      { asset: "USDC", timestamp: 2_000, price: "1.0001" },
      { asset: "blend:USDC", timestamp: 1_000, rate: "0.0525" },
    ]);
    expect(Object.keys(result).sort()).toEqual(["price:USDC", "rate:blend:USDC"]);
    const usdc = result["price:USDC"]!;
    expect(usdc.kind).toBe("price");
    expect(usdc.precision).toBe(DEFAULT_HISTORICAL_PRECISION);
    expect(usdc.points.map((p) => p.timestamp)).toEqual([1_000, 2_000]);
    expect(usdc.at(0)?.value.toFixedString()).toBe("0.9999000");
    expect(result["rate:blend:USDC"]!.at(0)?.value.toFixedString()).toBe("0.0525000");
  });

  it("accepts ISO-8601 timestamps", () => {
    const result = load([
      { asset: "USDC", timestamp: "2024-03-09T16:00:00Z", price: "1" },
    ]);
    expect(result["price:USDC"]!.at(0)?.timestamp).toBe(1_710_000_000_000);
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
    expect(result["rate:A"]!.at(0)?.value.toString()).toBe("2");
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
    expect(Object.keys(result).sort()).toEqual([
      "blend-usdc",
      "defindex-usdc",
    ]);
    expect(result["blend-usdc"]!.precision).toBe(DEFAULT_HISTORICAL_PRECISION);
    expect(result["defindex-usdc"]!.precision).toBe(2);
    expect(result["defindex-usdc"]!.at(0)?.value.toFixedString()).toBe("7.25");
  });

  it("accepts the { rows } wrapper", () => {
    const result = load({
      rows: [{ asset: "A", timestamp: 1, price: "1.5" }],
    });
    expect(result["price:A"]!.length).toBe(1);
  });

  it("supports multiple assets in one pass", () => {
    const result = load([
      { asset: "A", timestamp: 1, price: "1" },
      { asset: "B", timestamp: 1, price: "2" },
      { asset: "C", timestamp: 1, price: "3" },
    ]);
    expect(Object.keys(result).sort()).toEqual(["price:A", "price:B", "price:C"]);
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
    expect(result["price:A"]!.points.map((p) => p.timestamp)).toEqual([1, 2, 3]);
    expect(
      result["price:A"]!.points.map((p) => p.value.toString())
    ).toEqual(["1", "2", "3"]);
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
    expect(first["price:A"]!.length).toBe(1);
    expect(first["price:A"]!.at(0)?.value.toString()).toBe("1");

    const last = load(
      [
        { asset: "A", timestamp: 1, price: "1" },
        { asset: "A", timestamp: 1, price: "2" },
      ],
      { onDuplicate: "last" }
    );
    expect(last["price:A"]!.length).toBe(1);
    expect(last["price:A"]!.at(0)?.value.toString()).toBe("2");
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
    expectCode(
      () => load([{ asset: "A", timestamp: 1 }]),
      "malformed-input"
    );
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

  it("rejects an invalid precision option", () => {
    expectCode(
      () => load([{ asset: "A", timestamp: 1, price: "1" }], { precision: -1 }),
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
    expect(result["price:A"]!.points.map((p) => p.timestamp)).toEqual([1, 3]);
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
    expect(result["s"]!.points.map((p) => p.timestamp)).toEqual([1, 3]);
  });

  it("loads no point from a malformed both-fields row under skip", () => {
    const result = load(
      [
        { asset: "A", timestamp: 1, price: "1", rate: "bogus" },
        { asset: "A", timestamp: 2, price: "2", rate: "2" },
      ],
      { onMalformed: "skip" }
    );
    expect(result["price:A"]!.points.map((p) => p.timestamp)).toEqual([2]);
    expect(result["rate:A"]!.points.map((p) => p.timestamp)).toEqual([2]);
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
      loaded["price:USDC"]!.at(0)?.value.equals(
        FixedPoint.from("1.23456789", precision)
      )
    ).toBe(true);
    expect(
      loaded["price:USDC"]!.at(1)?.value.equals(
        FixedPoint.from("0.00000001", precision)
      )
    ).toBe(true);
    expect(
      loaded["rate:pool:blend"]!.at(0)?.value.equals(
        FixedPoint.from("5.25", precision)
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
      expect(again.length).toBe(series.length);
      series.points.forEach((point, index) => {
        expect(again.points[index]!.timestamp).toBe(point.timestamp);
        expect(again.points[index]!.value.equals(point.value)).toBe(true);
      });
    }
  });

  it("round-trips scientific-notation source values", () => {
    const loaded = load(
      [{ asset: "A", timestamp: 1, price: "1e-8" }],
      { precision: 8 }
    );
    expect(loaded["price:A"]!.at(0)?.value.toFixedString()).toBe("0.00000001");
  });
});
