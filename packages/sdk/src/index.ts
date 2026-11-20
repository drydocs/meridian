/**
 * @meridian/sdk: TypeScript client for Meridian vaults, keepers and the
 * Blend adapter. The keeper and adapter modules land in follow-up issues;
 * this entry point is where they will be re-exported.
 */

/** Semver version of this package. Kept in sync with package.json by a test. */
export const SDK_VERSION = "0.1.0";

export type {
  TimeoutOptions,
  VaultConfig,
  Position,
  Transaction,
  AdapterInfo,
  WithdrawPreview,
} from "./types.js";
export type { Rounding } from "./vault-base.js";
export {
  VaultBase,
  VIRTUAL_OFFSET,
  SHARE_PRICE_SCALE,
  DEFAULT_RPC_TIMEOUT_MS,
  convertAssetsToShares,
  convertSharesToAssets,
} from "./vault-base.js";
export {
  ErrorCode,
  MeridianError,
  ValidationError,
  SimulationError,
  SlippageError,
  NetworkError,
  TimeoutError,
  UnsupportedError,
  classifyError,
  isMeridianError,
} from "./errors.js";
export type { ErrorCodeValue, MeridianErrorOptions } from "./errors.js";
export { withRetry, retryDelayMs } from "./retry.js";
export type { RetryPolicy } from "./retry.js";
export { redact, redactString, REDACTED } from "./instrumentation.js";
export type {
  InstrumentationHooks,
  RequestEvent,
  RequestSuccessEvent,
  RequestErrorEvent,
  RetryEvent,
  SanitizedError,
} from "./instrumentation.js";
