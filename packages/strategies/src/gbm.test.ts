import { describe, it, expect } from "vitest";
import {
  generateGbmPath,
  generateGbmPaths,
  GbmPriceFeed,
  GBM_WORKING_SCALE,
  type GbmFeedOptions,
  type GbmPathOptions,
} from "./gbm";
import { Decimal } from "./decimal";
import {
  FixedPointDecimal,
  TimestampOutOfRangeError,
  UnknownAssetError,
} from "./types";
import type { AssetSymbol, PriceFeed, SimulationTimestamp } from "./types";
import { derivePathSeed } from "./rng";

const SEED = 20260101n;
const BASE_TIMESTAMP = 1_700_000_000_000;

function baseOptions(overrides: Partial<GbmPathOptions> = {}): GbmPathOptions {
  return {
    startPrice: "1",
    drift: "0.05",
    volatility: "0.2",
    steps: 32,
    seed: SEED,
    ...overrides,
  };
}

function asStrings(path: readonly FixedPointDecimal[]): string[] {
  return path.map((price) => price.toString());
}

function feedOptions(overrides: Partial<GbmFeedOptions> = {}): GbmFeedOptions {
  return { ...baseOptions(), ...overrides };
}

describe("generateGbmPath", () => {
  it("returns steps + 1 prices, starting at the start price", () => {
    const path = generateGbmPath(baseOptions({ steps: 10 }));

    expect(path).toHaveLength(11);
    expect(path[0]!.toString()).toBe("1");
    for (const price of path) {
      expect(price).toBeInstanceOf(FixedPointDecimal);
    }
  });

  it("returns just the start price when there are no steps", () => {
    const path = generateGbmPath(baseOptions({ steps: 0, startPrice: "1.25" }));

    expect(path).toHaveLength(1);
    expect(path[0]!.toString()).toBe("1.25");
  });

  it("reproduces a byte-identical path for the same seed", () => {
    expect(asStrings(generateGbmPath(baseOptions()))).toEqual(
      asStrings(generateGbmPath(baseOptions()))
    );
  });

  it("produces a different path for a different seed", () => {
    expect(asStrings(generateGbmPath(baseOptions()))).not.toEqual(
      asStrings(generateGbmPath(baseOptions({ seed: SEED + 1n })))
    );
  });

  it("holds the start price when drift and volatility are both zero", () => {
    const path = generateGbmPath(
      baseOptions({ drift: "0", volatility: "0", steps: 8 })
    );

    for (const price of path) {
      expect(price.toString()).toBe("1");
    }
  });

  it("compounds deterministically when volatility is zero", () => {
    const path = generateGbmPath(
      baseOptions({
        startPrice: "1000",
        drift: "0.07",
        volatility: "0",
        steps: 4,
      })
    );

    path.forEach((price, step) => {
      expect(Number(price.toString())).toBeCloseTo(
        1000 * Math.exp(0.07 * step),
        5
      );
    });
  });

  it("scales the drift by the step size", () => {
    const path = generateGbmPath(
      baseOptions({
        startPrice: "1000",
        drift: "0.07",
        volatility: "0",
        stepSize: "0.5",
        steps: 3,
      })
    );

    path.forEach((price, step) => {
      expect(Number(price.toString())).toBeCloseTo(
        1000 * Math.exp(0.07 * 0.5 * step),
        5
      );
    });
  });

  it("draws log-returns matching the configured drift and volatility", () => {
    const drift = 0.05;
    const volatility = 0.2;
    const steps = 250;
    const paths = generateGbmPaths(
      baseOptions({
        drift: String(drift),
        volatility: String(volatility),
        steps,
      }),
      24
    );

    const returns: number[] = [];
    for (const path of paths) {
      for (let i = 1; i < path.length; i += 1) {
        returns.push(
          Math.log(
            Number(path[i]!.toString()) / Number(path[i - 1]!.toString())
          )
        );
      }
    }

    const mean =
      returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1);
    const sampleSd = Math.sqrt(variance);

    const expectedMean = drift - volatility ** 2 / 2;
    const expectedSd = volatility;
    const standardError = expectedSd / Math.sqrt(returns.length);

    expect(returns).toHaveLength(24 * 250);
    expect(Math.abs(mean - expectedMean)).toBeLessThan(3 * standardError);
    expect(Math.abs(sampleSd - expectedSd)).toBeLessThan(0.05 * expectedSd);
  });

  it("accepts fixed-point decimals and Decimal values as inputs", () => {
    const fromStrings = generateGbmPath(baseOptions({ steps: 3 }));
    const fromDecimals = generateGbmPath(
      baseOptions({
        steps: 3,
        startPrice: FixedPointDecimal.fromString("1"),
        drift: new Decimal(50_000_000_000_000_000n, GBM_WORKING_SCALE),
        volatility: new Decimal(200_000_000_000_000_000n, GBM_WORKING_SCALE),
      })
    );

    expect(asStrings(fromDecimals)).toEqual(asStrings(fromStrings));
  });

  it("rejects a negative or fractional step count", () => {
    expect(() => generateGbmPath(baseOptions({ steps: -1 }))).toThrow(
      RangeError
    );
    expect(() => generateGbmPath(baseOptions({ steps: 1.5 }))).toThrow(
      RangeError
    );
  });

  it("rejects a negative step size", () => {
    expect(() => generateGbmPath(baseOptions({ stepSize: "-1" }))).toThrow(
      RangeError
    );
  });

  it("rejects an exponent beyond the representable range", () => {
    expect(() =>
      generateGbmPath(baseOptions({ drift: "1000", volatility: "0", steps: 1 }))
    ).toThrow(RangeError);

    expect(() =>
      generateGbmPath(
        baseOptions({ drift: "9".repeat(400), volatility: "0", steps: 1 })
      )
    ).toThrow(RangeError);
  });
});

describe("generateGbmPaths", () => {
  it("generates one independently reproducible path per index", () => {
    const options = baseOptions({ steps: 4 });
    const paths = generateGbmPaths(options, 3);

    expect(paths).toHaveLength(3);
    expect(asStrings(paths[0]!)).toEqual(
      asStrings(generateGbmPath({ ...options, seed: derivePathSeed(SEED, 0) }))
    );
    expect(asStrings(paths[2]!)).toEqual(
      asStrings(generateGbmPath({ ...options, seed: derivePathSeed(SEED, 2) }))
    );
    expect(asStrings(paths[0]!)).not.toEqual(asStrings(paths[1]!));
  });

  it("returns an empty batch for a count of zero", () => {
    expect(generateGbmPaths(baseOptions(), 0)).toEqual([]);
  });

  it("rejects a negative or fractional path count", () => {
    expect(() => generateGbmPaths(baseOptions(), -1)).toThrow(RangeError);
    expect(() => generateGbmPaths(baseOptions(), 1.5)).toThrow(RangeError);
  });
});

describe("GbmPriceFeed", () => {
  it("serves the generated path through the PriceFeed interface", () => {
    const feed: PriceFeed = GbmPriceFeed.generate(baseOptions({ steps: 5 }));

    const price = feed.getSpotPrice("USDC", 0);
    expect(price).toBeInstanceOf(FixedPointDecimal);
    expect(price.toString()).toBe("1");
    expect(feed.getSpotPrice("USDC", 5)).toBeInstanceOf(FixedPointDecimal);
  });

  it("exposes the underlying path", () => {
    const feed = GbmPriceFeed.generate(baseOptions({ steps: 3 }));

    expect(feed.path).toHaveLength(4);
    expect(feed.getSpotPrice("USDC", 2).equals(feed.path[2]!)).toBe(true);
  });

  it("defaults to USDC and rejects any other asset", () => {
    const feed = GbmPriceFeed.generate(baseOptions({ steps: 0 }));

    expect(() => feed.getSpotPrice("EURC", 0)).toThrow(UnknownAssetError);
  });

  it("serves a non-default asset when asked", () => {
    const feed = GbmPriceFeed.generate(
      feedOptions({ steps: 0, asset: "EURC" })
    );

    expect(feed.getSpotPrice("EURC", 0).toString()).toBe("1");
  });

  it("offsets timestamps by startTimestamp", () => {
    const feed = GbmPriceFeed.generate(
      feedOptions({ steps: 2, startTimestamp: BASE_TIMESTAMP })
    );

    expect(feed.getSpotPrice("USDC", BASE_TIMESTAMP).toString()).toBe("1");
    expect(() => feed.getSpotPrice("USDC", BASE_TIMESTAMP + 3)).toThrow(
      TimestampOutOfRangeError
    );
  });

  it("rejects timestamps outside the generated range", () => {
    const feed = GbmPriceFeed.generate(baseOptions({ steps: 3 }));

    expect(() => feed.getSpotPrice("USDC", -1)).toThrow(
      TimestampOutOfRangeError
    );
    expect(() => feed.getSpotPrice("USDC", 4)).toThrow(
      TimestampOutOfRangeError
    );
    expect(() => feed.getSpotPrice("USDC", 1.5)).toThrow(
      TimestampOutOfRangeError
    );

    try {
      feed.getSpotPrice("USDC", 4);
    } catch (error) {
      expect(error).toBeInstanceOf(TimestampOutOfRangeError);
      const range = error as TimestampOutOfRangeError;
      expect(range.timestamp).toBe(4);
      expect(range.minTimestamp).toBe(0);
      expect(range.maxTimestamp).toBe(3);
    }
  });

  it("runs a strategy written against PriceFeed without special-casing", () => {
    function totalReturn(
      feed: PriceFeed,
      asset: AssetSymbol,
      from: SimulationTimestamp,
      to: SimulationTimestamp
    ): number {
      return (
        Number(feed.getSpotPrice(asset, to).toString()) /
        Number(feed.getSpotPrice(asset, from).toString())
      );
    }

    const feed = GbmPriceFeed.generate(baseOptions({ steps: 10 }));

    expect(totalReturn(feed, "USDC", 0, 10)).toBeGreaterThan(0);
    expect(totalReturn(feed, "USDC", 0, 0)).toBe(1);
  });
});
