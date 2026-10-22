import { describe, it, expect } from "vitest";
import { XorShift64, derivePathSeed } from "./rng";

const MASK_64 = (1n << 64n) - 1n;
const TWO_53 = 9_007_199_254_740_992;
const RECORDED_42 = [
  45454805674n,
  11532217803599905471n,
  10021416941527320954n,
  2899061411254629736n,
];

function drawFloats(rng: XorShift64, count: number): number[] {
  return Array.from({ length: count }, () => rng.nextFloat());
}

describe("XorShift64", () => {
  it("reproduces the same sequence for the same seed", () => {
    expect(drawFloats(new XorShift64(42n), 100)).toEqual(
      drawFloats(new XorShift64(42n), 100)
    );
  });

  it("produces different sequences for different seeds", () => {
    expect(drawFloats(new XorShift64(42n), 10)).not.toEqual(
      drawFloats(new XorShift64(123n), 10)
    );
  });

  it("keeps the state inside 64 bits across many draws", () => {
    const rng = new XorShift64(0xdeadbeefcafef00dn);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0n);
      expect(value).toBeLessThanOrEqual(MASK_64);
    }
  });

  it("does not repeat a value within a short run", () => {
    const rng = new XorShift64(1n);
    const seen = new Set(
      Array.from({ length: 100 }, () => rng.next().toString())
    );
    expect(seen.size).toBe(100);
  });

  it("returns a bigint from next()", () => {
    expect(typeof new XorShift64(7n).next()).toBe("bigint");
  });

  it("remaps the all-zero seed, which is a fixed point of xorshift", () => {
    expect(new XorShift64(0n).next()).toBe(new XorShift64(1n).next());
  });

  it("masks a seed wider than 64 bits", () => {
    expect(new XorShift64((1n << 70n) | 42n).next()).toBe(
      new XorShift64(42n).next()
    );
  });
});

describe("XorShift64 state", () => {
  it("reports the masked seed as the state before any draw", () => {
    expect(new XorShift64(42n).getState()).toBe(42n);
    expect(new XorShift64(0n).getState()).toBe(1n);
    expect(new XorShift64((1n << 70n) | 42n).getState()).toBe(42n);
  });

  it("reports the last draw as the state, without advancing the stream", () => {
    const rng = new XorShift64(2024n);
    const drawn = rng.next();
    expect(rng.getState()).toBe(drawn);
    expect(rng.getState()).toBe(drawn);
    expect(rng.next()).not.toBe(drawn);
  });

  it("continues a stream restored mid-way exactly as the uninterrupted one", () => {
    const uninterrupted = new XorShift64(0xdeadbeefcafef00dn);
    const expected = drawFloats(uninterrupted, 200);

    const first = new XorShift64(0xdeadbeefcafef00dn);
    const head = drawFloats(first, 73);
    const resumed = XorShift64.fromState(first.getState());
    const tail = drawFloats(resumed, 127);

    expect([...head, ...tail]).toEqual(expected);
  });

  it("round-trips a state through a decimal string", () => {
    const rng = new XorShift64(MASK_64);
    for (let i = 0; i < 25; i += 1) rng.next();
    const restored = XorShift64.fromState(BigInt(rng.getState().toString()));
    expect(restored.next()).toBe(rng.next());
  });

  it("rejects a state no generator can hold", () => {
    for (const state of [0n, -1n, MASK_64 + 1n]) {
      expect(() => XorShift64.fromState(state)).toThrow(RangeError);
    }
  });

  it("accepts the full non-zero 64-bit range", () => {
    expect(XorShift64.fromState(1n).getState()).toBe(1n);
    expect(XorShift64.fromState(MASK_64).getState()).toBe(MASK_64);
  });

  it("does not change the sequence a seed produces", () => {
    // Recorded before the state accessors were added. A change here would move
    // every generated path and every recorded backtest result.
    const rng = new XorShift64(42n);
    expect(Array.from({ length: 4 }, () => rng.next())).toEqual(RECORDED_42);
  });
});

describe("XorShift64.nextFloat", () => {
  it("stays within [0, 1)", () => {
    const rng = new XorShift64(99n);
    for (let i = 0; i < 2_000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("is the top 53 bits of the next draw divided by 2^53", () => {
    const actual = new XorShift64(2024n);
    const expected = new XorShift64(2024n);
    for (let i = 0; i < 50; i += 1) {
      const raw = expected.next() >> 11n;
      expect(actual.nextFloat()).toBe(Number(raw) / TWO_53);
    }
  });

  it("varies across successive draws", () => {
    expect(new Set(drawFloats(new XorShift64(5n), 20)).size).toBe(20);
  });

  it("spreads uniformly enough to bucket evenly", () => {
    const rng = new XorShift64(314159n);
    const buckets = new Array<number>(10).fill(0);
    const draws = 10_000;
    for (let i = 0; i < draws; i += 1) {
      const index = Math.floor(rng.nextFloat() * 10);
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(draws / 10 - 200);
      expect(count).toBeLessThan(draws / 10 + 200);
    }
  });
});

describe("derivePathSeed", () => {
  it("is deterministic for a given seed and index", () => {
    expect(derivePathSeed(123n, 5)).toBe(derivePathSeed(123n, 5));
  });

  it("gives every path index its own seed", () => {
    const seeds = [0, 1, 2, 3, 4].map((index) =>
      derivePathSeed(42n, index).toString()
    );
    expect(new Set(seeds).size).toBe(5);
  });

  it("mixes rather than offsetting, so index 0 is not the raw seed", () => {
    expect(derivePathSeed(42n, 0)).not.toBe(42n);
  });

  it("stays inside 64 bits for the largest seed", () => {
    const seed = derivePathSeed(MASK_64, 12);
    expect(seed).toBeGreaterThanOrEqual(0n);
    expect(seed).toBeLessThanOrEqual(MASK_64);
  });

  it("rejects a negative index", () => {
    expect(() => derivePathSeed(1n, -1)).toThrow(RangeError);
  });

  it("rejects a non-integer index", () => {
    expect(() => derivePathSeed(1n, 1.5)).toThrow(RangeError);
  });
});
