import {
  FixedPointDecimal,
  UnknownAssetError,
  TimestampOutOfRangeError,
} from "./types";
import type { AssetSymbol, PriceFeed, SimulationTimestamp } from "./types";

export class StaticPriceFeed implements PriceFeed {
  readonly #prices: Map<AssetSymbol, FixedPointDecimal>;

  constructor(prices: Map<AssetSymbol, FixedPointDecimal>) {
    this.#prices = new Map(prices);
  }

  getSpotPrice(
    asset: AssetSymbol,
    _timestamp: SimulationTimestamp
  ): FixedPointDecimal {
    const price = this.#prices.get(asset);
    if (!price) {
      throw new UnknownAssetError(asset);
    }
    return price;
  }

  static create(
    prices: Record<AssetSymbol, string | FixedPointDecimal>
  ): StaticPriceFeed {
    const map = new Map<AssetSymbol, FixedPointDecimal>();
    for (const [asset, value] of Object.entries(prices)) {
      const price =
        value instanceof FixedPointDecimal
          ? value
          : FixedPointDecimal.fromString(value);
      map.set(asset as AssetSymbol, price);
    }
    return new StaticPriceFeed(map);
  }
}

export interface BacktestPricePoint {
  timestamp: SimulationTimestamp;
  price: FixedPointDecimal;
}

export class BacktestPriceFeed implements PriceFeed {
  readonly #data: Map<AssetSymbol, BacktestPricePoint[]>;

  constructor(data: Map<AssetSymbol, BacktestPricePoint[]>) {
    this.#data = new Map();
    for (const [asset, points] of data.entries()) {
      const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
      this.#data.set(asset, sorted);
    }
  }

  getSpotPrice(
    asset: AssetSymbol,
    timestamp: SimulationTimestamp
  ): FixedPointDecimal {
    const points = this.#data.get(asset);
    if (!points || points.length === 0) {
      throw new UnknownAssetError(asset);
    }

    // At this point, points has at least one element
    const first = points[0]!;
    const last = points[points.length - 1]!;

    if (timestamp < first.timestamp) {
      throw new TimestampOutOfRangeError(
        timestamp,
        first.timestamp,
        last.timestamp
      );
    }

    if (timestamp > last.timestamp) {
      throw new TimestampOutOfRangeError(
        timestamp,
        first.timestamp,
        last.timestamp
      );
    }

    let left = 0;
    let right = points.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midPoint = points[mid]!;
      if (midPoint.timestamp === timestamp) {
        return midPoint.price;
      }
      if (midPoint.timestamp < timestamp) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return points[right]!.price;
  }

  static create(
    data: Record<
      AssetSymbol,
      Array<{
        timestamp: SimulationTimestamp;
        price: string | FixedPointDecimal;
      }>
    >
  ): BacktestPriceFeed {
    const map = new Map<AssetSymbol, BacktestPricePoint[]>();
    for (const [asset, points] of Object.entries(data)) {
      map.set(
        asset as AssetSymbol,
        points.map((p) => ({
          timestamp: p.timestamp,
          price:
            p.price instanceof FixedPointDecimal
              ? p.price
              : FixedPointDecimal.fromString(p.price),
        }))
      );
    }
    return new BacktestPriceFeed(map);
  }

  getAvailableRange(
    asset: AssetSymbol
  ): { min: SimulationTimestamp; max: SimulationTimestamp } | null {
    const points = this.#data.get(asset);
    if (!points || points.length === 0) return null;
    return {
      min: points[0]!.timestamp,
      max: points[points.length - 1]!.timestamp,
    };
  }
}
