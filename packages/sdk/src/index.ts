/**
 * @meridian/sdk: TypeScript client for Meridian vaults, keepers and the
 * Blend adapter. The keeper and adapter modules land in follow-up issues;
 * this entry point is where they will be re-exported.
 */

/** Semver version of this package. Kept in sync with package.json by a test. */
export const SDK_VERSION = "0.1.0";

export type {
  VaultConfig,
  Position,
  Transaction,
  AdapterInfo,
} from "./types.js";
export type { Rounding } from "./vault-base.js";
export {
  VaultBase,
  VIRTUAL_OFFSET,
  convertAssetsToShares,
  convertSharesToAssets,
} from "./vault-base.js";
