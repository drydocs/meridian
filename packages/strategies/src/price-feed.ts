import type { FixedDecimal } from "./fixed-decimal";

export interface PriceFeed {
  getPrice(timestampMs: number): Promise<FixedDecimal>;
}

export type PriceFeedErrorCode =
  | "INVALID_TIMESTAMP"
  | "OUT_OF_RANGE"
  | "GAP";

export class PriceFeedError extends Error {
  constructor(
    readonly code: PriceFeedErrorCode,
    readonly timestampMs: number,
    message: string
  ) {
    super(message);
    this.name = "PriceFeedError";
  }
}

export interface PricePoint {
  timestampMs: number;
  price: FixedDecimal;
}

export function validateTimestamp(timestampMs: number): void {
  if (!Number.isSafeInteger(timestampMs)) {
    throw new PriceFeedError(
      "INVALID_TIMESTAMP",
      timestampMs,
      "Price-feed timestamps must be safe integer milliseconds"
    );
  }
}