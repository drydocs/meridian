<<<<<<< Updated upstream
export interface StrategyEngine {
  readonly name: string;
  readonly version: string;
}

export const STRATEGY_ENGINE: StrategyEngine = {
  name: "meridian-strategies",
  version: "0.1.0",
};
=======
export * from "./fixed-decimal";
export * from "./price-feed";
export * from "./mock-price-feed";
>>>>>>> Stashed changes
