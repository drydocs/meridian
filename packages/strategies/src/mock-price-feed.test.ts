import { describe, expect, it } from "vitest";
import {
  FixedDecimal,
  FixedPathPriceFeed,
  SyntheticPriceFeed,
} from "./index";

const price = (value: string) => FixedDecimal.fromString(value);

describe("FixedDecimal", () => {
  it("preserves exact decimal values at the configured scale", () => {
    expect(price("123.4500067").units).toBe(1_234_500_067n);
    expect(price("123.4500067").toString()).toBe("123.4500067");
    expect(FixedDecimal.fromString("-0.25", 2).toString()).toBe("-0.25");
  });

  it("rejects invalid precision, syntax, and scales", () => {
    expect(() => price("1.00000001")).toThrow(RangeError);
    expect(() => price("1e3")).toThrow(TypeError);
    expect(() => FixedDecimal.fromUnits(1n, 101)).toThrow(RangeError);
  });

  it("compares values with different scales", () => {
    expect(FixedDecimal.fromString("1.2", 1).equals(price("1.2000000"))).toBe(
      true
    );
    expect(FixedDecimal.fromString("1.21", 2).equals(price("1.2"))).toBe(
      false
    );
  });
});

describe("FixedPathPriceFeed", () => {
  it("returns exactly supplied prices without interpolation", async () => {
    const first = price("2.0000001");
    const second = price("9.8765432");
    const feed = new FixedPathPriceFeed([
      { timestampMs: 2_000, price: second },
      { timestampMs: 1_000, price: first },
    ]);

    await expect(feed.getPrice(1_000)).resolves.toBe(first);
    await expect(feed.getPrice(2_000)).resolves.toBe(second);
  });

  it("distinguishes interior gaps from out-of-range reads", async () => {
    const feed = new FixedPathPriceFeed([
      { timestampMs: 1_000, price: price("1") },
      { timestampMs: 3_000, price: price("3") },
    ]);

    await expect(feed.getPrice(2_000)).rejects.toMatchObject({
      code: "GAP",
      timestampMs: 2_000,
    });
    await expect(feed.getPrice(0)).rejects.toMatchObject({
      code: "OUT_OF_RANGE",
    });
    await expect(feed.getPrice(4_000)).rejects.toMatchObject({
      code: "OUT_OF_RANGE",
    });
  });

  it("rejects empty paths, duplicate timestamps, and invalid reads", async () => {
    expect(() => new FixedPathPriceFeed([])).toThrow(RangeError);
    expect(
      () =>
        new FixedPathPriceFeed([
          { timestampMs: 1, price: price("1") },
          { timestampMs: 1, price: price("2") },
        ])
    ).toThrow(RangeError);

    const feed = new FixedPathPriceFeed([
      { timestampMs: 1, price: price("1") },
    ]);
    await expect(feed.getPrice(1.5)).rejects.toMatchObject({
      code: "INVALID_TIMESTAMP",
    });
  });
});

describe("SyntheticPriceFeed", () => {
  const options = {
    seed: "scenario-alpha",
    startTimestampMs: 1_700_000_000_000,
    intervalMs: 60_000,
    points: 32,
    initialPrice: price("100.0000000"),
    volatilityBps: 125,
    driftBps: 2,
  };

  async function readPath(feed: SyntheticPriceFeed): Promise<string[]> {
    return Promise.all(
      Array.from({ length: options.points }, async (_, index) =>
        (await feed.getPrice(options.startTimestampMs + index * options.intervalMs)).toString()
      )
    );
  }

  it("generates the same path for the same seed across instances", async () => {
    const firstRun = await readPath(new SyntheticPriceFeed(options));
    const secondRun = await readPath(new SyntheticPriceFeed(options));
    expect(secondRun).toEqual(firstRun);
    expect(firstRun[0]).toBe("100");
    expect(new Set(firstRun).size).toBeGreaterThan(1);
  });

  it("changes the path when the seed changes", async () => {
    const firstRun = await readPath(new SyntheticPriceFeed(options));
    const secondRun = await readPath(
      new SyntheticPriceFeed({ ...options, seed: "scenario-beta" })
    );
    expect(secondRun).not.toEqual(firstRun);
  });

  it("supports zero volatility and reports reads beyond generated points", async () => {
    const feed = new SyntheticPriceFeed({
      ...options,
      points: 2,
      volatilityBps: 0,
      driftBps: 0,
    });
    await expect(feed.getPrice(options.startTimestampMs + options.intervalMs)).resolves.toBe(
      options.initialPrice
    );
    await expect(feed.getPrice(options.startTimestampMs + options.intervalMs * 2)).rejects.toMatchObject({
      code: "OUT_OF_RANGE",
    });
  });

  it("validates generation options", () => {
    expect(() => new SyntheticPriceFeed({ ...options, points: 0 })).toThrow(
      RangeError
    );
    expect(() => new SyntheticPriceFeed({ ...options, intervalMs: 0 })).toThrow(
      RangeError
    );
    expect(() => new SyntheticPriceFeed({ ...options, volatilityBps: -1 })).toThrow(
      RangeError
    );
    expect(() => new SyntheticPriceFeed({ ...options, initialPrice: price("0") })).toThrow(
      RangeError
    );
  });
});