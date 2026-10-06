export * from "./decimal";

export interface StrategyEngine {
  readonly name: string;
  readonly version: string;
}

export const STRATEGY_ENGINE: StrategyEngine = {
  name: "meridian-strategies",
  version: "0.1.0",
};

export * from "./types";
export * from "./feeds";
export * from "./risk-metrics";
export * from "./reflector-oracle-price-feed";
export * from "./rng";
export * from "./gbm";
export * from "./sizing";
export * from "./portfolio";
export * from "./strategy";
export * from "./clock";
export * from "./funding";
export * from "./scenario";
export * from "./delta-neutral";
export * from "./costs";
export * from "./slippage-model";
export * from "./time-series";
export * from "./historical-loader";
export * from "./models/liquidation-parameter";
