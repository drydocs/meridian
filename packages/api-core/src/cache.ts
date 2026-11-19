import { APP_NETWORK } from "@meridian/shared";

export const MAINNET_VAULT_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";
export const TESTNET_VAULT_CACHE_CONTROL = "no-store";

export const HISTORY_CACHE_CONTROL =
  "public, s-maxage=30, stale-while-revalidate=120";

/**
 * Cache-Control for successful (200) vault-read responses: a short CDN cache
 * on mainnet, nothing at all on testnet so post-deposit reads stay fresh.
 */
export function vaultReadCacheControl(
  network: "mainnet" | "testnet" = APP_NETWORK.network
): string {
  return network === "testnet"
    ? TESTNET_VAULT_CACHE_CONTROL
    : MAINNET_VAULT_CACHE_CONTROL;
}
