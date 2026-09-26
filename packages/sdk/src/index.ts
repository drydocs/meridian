/** Public package version, kept in sync with package.json for consumers. */
export const SDK_VERSION = "0.1.0" as const;

export interface MeridianSdkInfo {
  readonly name: "@meridian/sdk";
  readonly version: typeof SDK_VERSION;
}

/** Returns immutable metadata that can be used in integration diagnostics. */
export function getSdkInfo(): MeridianSdkInfo {
  return {
    name: "@meridian/sdk",
    version: SDK_VERSION,
  };
}
