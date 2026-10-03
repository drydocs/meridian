export interface PricePoint {
  price: number;
  timestamp: number;
}

export interface PriceFeed {
  onPriceUpdate: (point: PricePoint) => void;
  getCurrentPrice: () => number;
}

export class SimplePriceFeed implements PriceFeed {
  private currentPrice: number;

  constructor(initialPrice: number) {
    this.currentPrice = initialPrice;
  }

  onPriceUpdate(point: PricePoint): void {
    this.currentPrice = point.price;
  }

  getCurrentPrice(): number {
    return this.currentPrice;
  }
}

export function createPriceFeedFromPath(
  path: number[],
  startTimestamp: number = 0
): PriceFeed {
  return new SimplePriceFeed(path[0] || 0);
}