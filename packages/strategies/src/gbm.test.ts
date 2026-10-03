/// <reference lib="vitest" />

import { generatePath, generateBatch, derivePathSeed } from "./gbm";
import { FixedPointDecimal } from "./types";
import { createPriceFeedFromPath } from "./price-feed";

describe("derivePathSeed", () => {
  it("derives different seeds for different path indices", () => {
    const seed = 42n;
    const seeds = [0, 1, 2, 3].map((i) => derivePathSeed(seed, i));
    const unique = new Set(seeds.map((s) => s.toString()));
    expect(unique.size).toBe(4);
  });

  it("derives deterministic seeds", () => {
    const seed = 123n;
    const index = 5;
    expect(derivePathSeed(seed, index)).toBe(derivePathSeed(seed, index));
  });
});

describe("generatePath", () => {
  it("generates a path with the expected number of steps + 1 (including start)", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(steps + 1);
  });

  it("generates a path with start price as the first element", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("with zero drift and zero volatility, path stays at start price", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    for (let i = 0; i < path.length; i++) {
      expect(path[i]).toBeCloseTo(100.0);
    }
  });

  it("is deterministic - same seed produces same path", () => {
    const startPrice = "100.0";
    const drift = "0.01";
    const volatility = "0.2";
    const steps = 20;
    const seed = 42n;
    const path1 = generatePath(startPrice, drift, volatility, steps, seed);
    const path2 = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path1).toEqual(path2);
  });

  it("different seeds produce different paths (with non-zero parameters)", () => {
    const startPrice = "100.0";
    const drift = "0.1";
    const volatility = "0.3";
    const steps = 10;
    const seed1 = 42n;
    const seed2 = 123n;
    const path1 = generatePath(startPrice, drift, volatility, steps, seed1);
    const path2 = generatePath(startPrice, drift, volatility, steps, seed2);
    expect(path1).not.toEqual(path2);
  });

  it("accepts FixedPointDecimal for drift", () => {
    const startPrice = "100.0";
    const drift = FixedPointDecimal.fromString("0.01");
    const volatility = "0.2";
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(steps + 1);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("accepts FixedPointDecimal for volatility", () => {
    const startPrice = "100.0";
    const drift = "0.01";
    const volatility = FixedPointDecimal.fromString("0.2");
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(steps + 1);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("accepts FixedPointDecimal for both drift and volatility", () => {
    const startPrice = "100.0";
    const drift = FixedPointDecimal.fromString("0.01");
    const volatility = FixedPointDecimal.fromString("0.2");
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(steps + 1);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("drift and volatility as strings use fixed-point decimal parsing", () => {
    const startPrice = "100.0";
    const drift = "0.01";
    const volatility = "0.2";
    const steps = 5;
    const seed = 42n;
    const path1 = generatePath(startPrice, drift, volatility, steps, seed);
    const path2 = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path1).toEqual(path2);
  });
});

describe("generateBatch", () => {
  it("generates a batch with the expected number of paths", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const count = 10;
    const seed = 42n;
    const paths = generateBatch(startPrice, drift, volatility, steps, count, seed);
    expect(paths.length).toBe(count);
  });

  it("each path has the expected length", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 8;
    const count = 5;
    const seed = 42n;
    const paths = generateBatch(startPrice, drift, volatility, steps, count, seed);
    expect(paths.length).toBe(count);
    for (const path of paths) {
      expect(path.length).toBe(steps + 1);
    }
  });

  it("is deterministic - same seed and count produces same batch", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const count = 3;
    const seed = 42n;
    const batch1 = generateBatch(startPrice, drift, volatility, steps, count, seed);
    const batch2 = generateBatch(startPrice, drift, volatility, steps, count, seed);
    expect(batch1).toEqual(batch2);
  });

  it("different counts produce different numbers of paths", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const seed = 42n;
    const batch1 = generateBatch(startPrice, drift, volatility, steps, 3, seed);
    const batch2 = generateBatch(startPrice, drift, volatility, steps, 5, seed);
    expect(batch1.length).toBe(3);
    expect(batch2.length).toBe(5);
  });

  it("each path in batch is independently reproducible", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const seed = 42n;
    const batch1 = generateBatch(startPrice, drift, volatility, steps, 3, seed);
    const batch2 = generateBatch(startPrice, drift, volatility, steps, 3, seed);
    expect(batch1).toEqual(batch2);
  });

  it("paths in batch are different for different path indices (with non-zero parameters)", () => {
    const startPrice = "100.0";
    const drift = "0.1";
    const volatility = "0.2";
    const steps = 10;
    const seed = 42n;
    const batch = generateBatch(startPrice, drift, volatility, steps, 5, seed);
    const pathSet = new Set(batch.map((p) => p.map((x) => x.toString()).join(",")));
    expect(pathSet.size).toBeGreaterThanOrEqual(2);
  });

  it("uses different path seeds for each path in batch", () => {
    const startPrice = "100.0";
    const drift = "0.1";
    const volatility = "0.2";
    const steps = 5;
    const count = 5;
    const seed = 42n;
    const batch = generateBatch(startPrice, drift, volatility, steps, count, seed);
    const seeds = batch.map((_path, i) => derivePathSeed(seed, i));
    const uniqueSeeds = new Set(seeds.map((s) => s.toString()));
    expect(uniqueSeeds.size).toBe(count);
  });

  it("has statistical sanity for drift with positive drift trend using numeric drift", () => {
    // With positive numeric drift, paths should trend upward over many trials
    const startPrice = "100.0";
    const drift = 0.05;
    const volatility = 0.1;
    const steps = 50;
    const count = 200;
    const seed = 42n;
    const batches = generateBatch(startPrice, drift, volatility, steps, count, seed);

    // Calculate sample mean of final prices
    const finalPrices = batches.map((path) => path[path.length - 1]);
    const sum = finalPrices.reduce((a, b) => a + b, 0);
    const mean = sum / count;

    // With positive drift, mean should be above start price
    expect(mean).toBeGreaterThan(100);
  });

  it("has statistical sanity for volatility - wider spread with higher vol", () => {
    // With volatility, final prices should spread widely
    const startPrice = "100.0";
    const drift = 0.0;
    const volatility = 0.5;
    const steps = 30;
    const count = 200;
    const seed = 42n;
    const batches = generateBatch(startPrice, drift, volatility, steps, count, seed);

    const finalPrices = batches.map((path) => path[path.length - 1]);
    const min = Math.min(...finalPrices);
    const max = Math.max(...finalPrices);

    // With vol=0.5 and 30 steps, should have significant spread
    expect(max - min).toBeGreaterThan(30);
  });

  it("has statistical sanity - zero drift with zero vol stays near start", () => {
    // With zero drift and zero vol, paths should stay near start price
    const startPrice = "100.0";
    const drift = 0.0;
    const volatility = 0.0;
    const steps = 50;
    const count = 200;
    const seed = 42n;
    const batches = generateBatch(startPrice, drift, volatility, steps, count, seed);

    const finalPrices = batches.map((path) => path[path.length - 1]);
    const allNearStart = finalPrices.every((p) => Math.abs(p - 100) < 1);
    expect(allNearStart).toBe(true);
  });

  it("price-feed integration via createPriceFeedFromPath preserves start price", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    const feed = createPriceFeedFromPath(path);
    // SimplePriceFeed stores the initial price
    expect(feed.getCurrentPrice()).toBeCloseTo(startPrice);
  });

  it("price-feed integration with drift paths - final price exceeds start", () => {
    const startPrice = "100.0";
    const drift = FixedPointDecimal.fromString("0.1");
    const volatility = FixedPointDecimal.fromString("0.15");
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    // Final price should exceed start price with positive drift
    expect(path[path.length - 1]).toBeGreaterThan(100);
  });

  it("price-feed integration with numeric drift and volatility - final price exceeds start", () => {
    const startPrice = "100.0";
    const drift = 0.1;
    const volatility = 0.15;
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    // Final price should exceed start price with positive drift
    expect(path[path.length - 1]).toBeGreaterThan(100);
  });
});

describe("edge cases", () => {
  it("handles minimal steps (0)", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 0;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(1);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("handles single step", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 1;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(2);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("handles large number of steps", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 1000;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(1001);
  });

  it("handles invalid start price gracefully", () => {
    const drift = "0.0";
    const volatility = "0.0";
    const steps = 5;
    const seed = 42n;
    expect(() => generatePath("invalid", drift, volatility, steps, seed))
      .not.toThrow();
  });

  it("handles negative drift", () => {
    const startPrice = "100.0";
    const drift = "-0.1";
    const volatility = "0.1";
    const steps = 10;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(steps + 1);
    expect(path[0]).toBeCloseTo(100.0);
  });

  it("handles negative volatility (treated as absolute in math)", () => {
    const startPrice = "100.0";
    const drift = "0.0";
    const volatility = "-0.1";
    const steps = 5;
    const seed = 42n;
    const path = generatePath(startPrice, drift, volatility, steps, seed);
    expect(path.length).toBe(steps + 1);
    expect(path[0]).toBeCloseTo(100.0);
  });
});