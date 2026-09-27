export interface StrategyEngine {
  readonly name: string;
  readonly version: string;
}

export const STRATEGY_ENGINE: StrategyEngine = {
  name: "meridian-strategies",
  version: "0.1.0",
};

export * from "./decimal";
export * from "./config";
export * from "./liquidation";
export * from "./self-repaying-loan";
