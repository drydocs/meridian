import { APP_NETWORK } from "@meridian/shared";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";

export function resolveCoordinatorVault(): { contractId: string } | null {
  const pools =
    APP_NETWORK.network === "testnet"
      ? KNOWN_POOLS.testnet
      : KNOWN_POOLS.mainnet;
  const entry = Object.values(pools).find(
    (pool): pool is typeof pool & { contractId: string } =>
      pool.protocol === "meridian" && Boolean(pool.contractId)
  );
  return entry ? { contractId: entry.contractId } : null;
}
