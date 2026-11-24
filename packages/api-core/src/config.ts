import {
  APP_ADDRESSES,
  APP_NETWORK,
  MUSDC_ISSUER,
  SUPPORTED_STABLECOINS,
  isDefindexConfigured,
  type SupportedStablecoin,
} from "@meridian/shared";
import { fetchCoordinatorState } from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

/**
 * Short cache policy for public config reads: cached briefly at both the
 * browser and CDN edge, with stale-while-revalidate to ride out transient
 * RPC blips when resolving the live active adapter.
 */
export const CONFIG_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

export interface PublicConfigContracts {
  vault: string;
  usdc: string;
  musdc: string;
  eurc: string;
  blendPool: string;
  defindexVault: string | null;
  defindexFactory: string | null;
}

export interface ActiveAdapterInfo {
  address: string;
  protocol: string;
}

export interface PublicConfigFeatures {
  defindexEnabled: boolean;
  musdcTrustlineRequired: boolean;
  riskAcknowledgementRequired: boolean;
}

export interface PublicConfigResponse {
  network: "testnet" | "mainnet";
  passphrase: string;
  contracts: PublicConfigContracts;
  activeAdapter: ActiveAdapterInfo | null;
  degraded: boolean;
  supportedAssets: readonly SupportedStablecoin[];
  features: PublicConfigFeatures;
}

/**
 * Returns public network, contract, active adapter, asset, and feature-flag
 * metadata derived from @meridian/shared constants and live coordinator state.
 * Deliberately excludes RPC/infrastructure URLs, keeper settings, admin
 * addresses, and any secrets.
 */
export async function handleGetConfig(): Promise<RouteResult> {
  const defindexVault =
    (process.env.DEFINDEX_VAULT_ID ?? APP_ADDRESSES.defindex.vault) || null;

  let activeAdapter: ActiveAdapterInfo | null = null;
  let adapterError: unknown;

  if (APP_ADDRESSES.vault) {
    try {
      const state = await fetchCoordinatorState({
        contractId: APP_ADDRESSES.vault,
        network: APP_NETWORK,
      });
      activeAdapter = {
        address: state.adapterId,
        protocol: state.protocol,
      };
    } catch (err) {
      adapterError = err;
    }
  }

  const body: PublicConfigResponse = {
    network: APP_NETWORK.network,
    passphrase: APP_NETWORK.passphrase,
    contracts: {
      vault: APP_ADDRESSES.vault,
      usdc: APP_ADDRESSES.usdc,
      musdc: APP_ADDRESSES.musdc,
      eurc: APP_ADDRESSES.eurc,
      blendPool: APP_ADDRESSES.blend.pool,
      defindexVault,
      defindexFactory: APP_ADDRESSES.defindex.factory || null,
    },
    activeAdapter,
    degraded: adapterError !== undefined,
    supportedAssets: [...SUPPORTED_STABLECOINS],
    features: {
      defindexEnabled: isDefindexConfigured(),
      musdcTrustlineRequired: Boolean(MUSDC_ISSUER[APP_NETWORK.network]),
      riskAcknowledgementRequired: true,
    },
  };

  return adapterError !== undefined
    ? { status: 200, body, error: adapterError }
    : { status: 200, body };
}
