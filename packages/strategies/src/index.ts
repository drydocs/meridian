/**
 * @meridian/strategies - Strategy-related adapters and implementations
 *
 * This package provides adapters for integrating external data sources
 * and oracles with Meridian's strategy execution system.
 */

export {
  createReflectorOraclePriceFeed,
  ReflectorOracleError,
  StaleOracleDataError,
  MissingOracleDataError,
  type ReflectorOraclePriceFeedOptions,
  type ReflectorOracleClient,
  type ReflectorAsset,
  type ReflectorPriceData,
} from "./reflector-oracle-price-feed.js";
