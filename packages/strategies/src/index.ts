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
