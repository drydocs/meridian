import type { Fixed } from "./decimal";

/** A single market observation on the simulation clock. */
export interface MarketTick {
  /** Zero-based position in the clock. */
  readonly index: number;
  /** Timestamp in milliseconds, `startTime + index * stepMs`. */
  readonly timestamp: number;
  /** Mark price per asset, ordered by asset name. */
  readonly prices: ReadonlyMap<string, Fixed>;
}

/** An ordered, finite list of market ticks. */
export interface SimulationClock {
  readonly ticks: readonly MarketTick[];
}

export interface ClockSpec {
  readonly startTime: number;
  /** Fixed spacing between consecutive ticks, in milliseconds. */
  readonly stepMs: number;
  /** One mark-price record per tick; every record shares the same assets. */
  readonly pricePath: readonly Readonly<Record<string, Fixed>>[];
}

/**
 * Builds a deterministic clock from a fixed price path. Ticks are ordered by
 * index and stamped `startTime + index * stepMs`; asset keys are read in
 * sorted order so map iteration is reproducible across runs.
 */
export function createClock(spec: ClockSpec): SimulationClock {
  if (!Number.isInteger(spec.startTime)) {
    throw new RangeError("createClock: startTime must be an integer");
  }
  if (!Number.isInteger(spec.stepMs) || spec.stepMs <= 0) {
    throw new RangeError("createClock: stepMs must be a positive integer");
  }

  const assets = resolveAssets(spec.pricePath);
  const ticks = spec.pricePath.map((record, index) => {
    const prices = new Map<string, Fixed>();
    for (const asset of assets) {
      const price = record[asset];
      if (price === undefined) {
        throw new RangeError(
          `createClock: tick ${index} is missing a price for "${asset}"`
        );
      }
      if (price <= 0n) {
        throw new RangeError(
          `createClock: tick ${index} price for "${asset}" must be positive`
        );
      }
      prices.set(asset, price);
    }
    return { index, timestamp: spec.startTime + index * spec.stepMs, prices };
  });

  return { ticks };
}

function resolveAssets(
  pricePath: readonly Readonly<Record<string, Fixed>>[]
): readonly string[] {
  const first = pricePath[0];
  if (!first) {
    throw new RangeError("createClock: pricePath must not be empty");
  }
  const assets = Object.keys(first).sort();
  if (assets.length === 0) {
    throw new RangeError("createClock: ticks must expose at least one asset");
  }
  for (const record of pricePath) {
    const keys = Object.keys(record).sort();
    const same =
      keys.length === assets.length &&
      keys.every((key, i) => key === assets[i]);
    if (!same) {
      throw new RangeError(
        "createClock: every tick must expose the same assets"
      );
    }
  }
  return assets;
}
