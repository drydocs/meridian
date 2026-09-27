export * from "./decimal";
export * from "./liquidation";
export * from "./config";
export * from "./monitor";

export interface StrategyEngine {
  readonly name: string;
  readonly version: string;
}

export const STRATEGY_ENGINE: StrategyEngine = {
  name: "meridian-strategies",
  version: "0.1.0",
};
