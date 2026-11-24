import { APP_NETWORK } from "@meridian/shared";

// Cache policy shared by both vault-read endpoints: the list in
// v1/vaults/index.ts and the single-vault read in v1/vaults/[vaultId].ts.
// Both must use the same policy — #1051 happened because the detail endpoint
// cached unconditionally while the list did not, so on testnet the detail
// panel served pre-deposit balances and APY for up to a minute while the list
// beside it was already current. Mainnet APY/TVL move slowly, so a short
// fresh window keeps DeFiLlama call volume low, and stale-while-revalidate
// lets the edge keep serving the last good payload through a transient
// DeFiLlama outage instead of failing the whole dashboard. Testnet reads hit
// the chain on every call (fetchAllVaults bypasses its cache there) so
// deposits/withdrawals show up immediately during testing; an HTTP cache
// layered on top would defeat that, so testnet gets no-store.
export const MAINNET_VAULT_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";
export const TESTNET_VAULT_CACHE_CONTROL = "no-store";

export const HISTORY_CACHE_CONTROL =
  "public, s-maxage=30, stale-while-revalidate=120";

/**
 * Cache-Control for successful (200) vault-read responses: a short CDN cache
 * on mainnet, nothing at all on testnet so post-deposit reads stay fresh.
 */
export function vaultReadCacheControl(network?: "mainnet" | "testnet"): string {
  const activeNetwork =
    network ??
    (process.env.STELLAR_NETWORK === "testnet"
      ? "testnet"
      : APP_NETWORK.network);
  return activeNetwork === "testnet"
    ? TESTNET_VAULT_CACHE_CONTROL
    : MAINNET_VAULT_CACHE_CONTROL;
}
