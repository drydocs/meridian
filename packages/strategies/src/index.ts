import { STRATEGY_ENGINE_VERSION } from "./engine";
export * from "./decimal";
export * from "./guard";
export * from "./volatility";

export interface StrategyEngine {
  readonly name: string;
  readonly version: string;
}

export const STRATEGY_ENGINE: StrategyEngine = {
  name: "meridian-strategies",
  version: STRATEGY_ENGINE_VERSION,
};

export * from "./types";
export * from "./feeds";
export * from "./risk-metrics";
export * from "./reflector-oracle-price-feed";
export * from "./rng";
export * from "./gbm";
export * from "./sizing";
export * from "./backtest";
export * from "./portfolio";
export * from "./venue";
export * from "./strategy";
export * from "./composition";
export * from "./clock";
export * from "./funding";
export * from "./scenario";
export * from "./delta-neutral";
export * from "./costs";
export * from "./slippage-model";
export * from "./time-series";
export * from "./historical-loader";
export * from "./models/liquidation-parameter";
export * from "./multi-collateral";
export * from "./config";
export * from "./projections";
export * from "./self-repaying-loan";
export * from "./monitor";
export * from "./scenario-runner";
export * from "./accrual";
export * from "./liquidation";
export * from "./correlated-paths";
export * from "./regime-scenarios";
export * from "./rebalance";
export * from "./report";
export * from "./report-builder";
export * from "./registry";
export * from "./composition/capital-allocation";
export * from "./composition/correlation-matrix";
export * from "./composition/constraint-engine";

export * from "./scenario-sources";
export * from "./execute-scenario";
