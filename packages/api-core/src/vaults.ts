import { isDefindexConfigured, APP_NETWORK } from "@meridian/shared";
import {
  fetchAllVaults,
  fetchVaultsWithCache,
  selectBestVault,
} from "@meridian/stellar-sdk-helpers";
import type { RouteResult } from "./types";

export async function handleGetVaults(): Promise<RouteResult> {
  try {
    const { vaults, cached } = await fetchVaultsWithCache(APP_NETWORK.network);
    const best = selectBestVault(vaults, {
      defindexConfigured: isDefindexConfigured(),
    });
    return {
      status: 200,
      body: {
        vaults,
        recommendedVaultId: best?.id ?? null,
        updatedAt: new Date().toISOString(),
        cached,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { error: "Failed to fetch vaults" },
      error: err,
    };
  }
}

/**
 * Fetches and returns a single vault by ID. Does not validate `vaultId`
 * against the known-pools registry before fetching — callers that want to
 * avoid a wasted fetch for an unrecognized ID (e.g. the Vercel handler, which
 * checks against KNOWN_POOLS to skip fetching for garbage input) should do
 * that check before calling this function.
 */
export async function handleGetVaultById(
  vaultId: string
): Promise<RouteResult> {
  try {
    const vaults = await fetchAllVaults(APP_NETWORK.network);
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) {
      return { status: 404, body: { error: "vault not found", vaultId } };
    }
    return { status: 200, body: vault };
  } catch (err) {
    return {
      status: 500,
      body: { error: "Failed to fetch vault" },
      error: err,
    };
  }
}
