import { FixedDecimal } from "./fixed-decimal";
import {
  PriceFeedError,
  type PriceFeed,
  type PricePoint,
  validateTimestamp,
} from "./price-feed";

export class FixedPathPriceFeed implements PriceFeed {
  private readonly prices: ReadonlyMap<number, FixedDecimal>;
  private readonly firstTimestamp: number;
  private readonly lastTimestamp: number;

  constructor(points: readonly PricePoint[]) {
    if (points.length === 0) {
      throw new RangeError("A fixed price path must contain at least one point");
    }

    const prices = new Map<number, FixedDecimal>();
    for (const point of points) {
      validateTimestamp(point.timestampMs);
      if (prices.has(point.timestampMs)) {
        throw new RangeError(`Duplicate price timestamp: ${point.timestampMs}`);
      }
      prices.set(point.timestampMs, point.price);
    }

    const timestamps = [...prices.keys()].sort((left, right) => left - right);
    this.prices = prices;
    this.firstTimestamp = timestamps[0]!;
    this.lastTimestamp = timestamps[timestamps.length - 1]!;
  }

  async getPrice(timestampMs: number): Promise<FixedDecimal> {
    validateTimestamp(timestampMs);
    const price = this.prices.get(timestampMs);
    if (price) return price;

    const code =
      timestampMs < this.firstTimestamp || timestampMs > this.lastTimestamp
        ? "OUT_OF_RANGE"
        : "GAP";
    throw new PriceFeedError(
      code,
      timestampMs,
      code === "GAP"
        ? `No price is defined at timestamp ${timestampMs}`
        : `Timestamp ${timestampMs} is outside the configured price path`
    );
  }
}

export interface SyntheticPriceFeedOptions {
  seed: number | string;
  startTimestampMs: number;
  intervalMs: number;
  points: number;
  initialPrice: FixedDecimal;
  volatilityBps?: number;
  driftBps?: number;
}

export class SyntheticPriceFeed implements PriceFeed {
  private readonly path: FixedPathPriceFeed;

  constructor(options: SyntheticPriceFeedOptions) {
    const {
      seed,
      startTimestampMs,
      intervalMs,
      points,
      initialPrice,
      volatilityBps = 100,
      driftBps = 0,
    } = options;

    validateTimestamp(startTimestampMs);
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError("intervalMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(points) || points <= 0) {
      throw new RangeError("points must be a positive safe integer");
    }
    if (!Number.isInteger(volatilityBps) || volatilityBps < 0) {
      throw new RangeError("volatilityBps must be a non-negative integer");
    }
    if (!Number.isInteger(driftBps)) {
      throw new RangeError("driftBps must be an integer");
    }
    if (driftBps - volatilityBps <= -10_000) {
      throw new RangeError("Price changes must not reduce a price to zero or less");
    }
    if (initialPrice.units <= 0n) {
      throw new RangeError("initialPrice must be greater than zero");
    }
    const endTimestampMs = startTimestampMs + (points - 1) * intervalMs;
    validateTimestamp(endTimestampMs);

    const random = createSeededRandom(seed);
    const prices: PricePoint[] = [{
      timestampMs: startTimestampMs,
      price: initialPrice,
    }];
    let units = initialPrice.units;
    const scale = initialPrice.scale;
    const basisPointScale = 10_000n;
    const changeRange = BigInt(volatilityBps) * 2n + 1n;

    for (let index = 1; index < points; index += 1) {
      const randomChange =
        volatilityBps === 0
          ? 0n
          : BigInt(random()) % changeRange - BigInt(volatilityBps);
      const changeBps = BigInt(driftBps) + randomChange;
      units = (units * (basisPointScale + changeBps)) / basisPointScale;
      if (units <= 0n) {
        throw new RangeError("Synthetic path generated a non-positive price");
      }
      prices.push({
        timestampMs: startTimestampMs + index * intervalMs,
        price: FixedDecimal.fromUnits(units, scale),
      });
    }

    this.path = new FixedPathPriceFeed(prices);
  }

  getPrice(timestampMs: number): Promise<FixedDecimal> {
    return this.path.getPrice(timestampMs);
  }
}

function createSeededRandom(seed: number | string): () => number {
  const seedText = String(seed);
  let state = 2_166_136_261;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  if (state === 0) state = 2_654_435_761;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}