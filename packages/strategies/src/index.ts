export interface StrategyEngine {
  readonly name: string;
  readonly version: string;
}

export const STRATEGY_ENGINE = {
  name: "meridian-strategies",
  version: "0.1.0",
};

export * from "./types";
export * from "./feeds";
export * from "./rng";
export * from "./decimal";
export * from "./gbm";
export type { PricePoint } from "./price-feed";
export { SimplePriceFeed, createPriceFeedFromPath } from "./price-feed";
