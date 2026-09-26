import type { ApiVault } from "./vaults";

export interface RouteOptions {
  // Retained for backward compatibility. Third-party pools (Blend, DeFindex)
  // are display-only; all deposits route through the Meridian coordinator vault (#850).
  defindexConfigured?: boolean;
}

// A vault is routable only if Meridian can build a deposit for its protocol.
// Only Meridian coordinator vaults can be deposited into; third-party pools
// (Blend, DeFindex) are displayed for comparison but cannot be deposited into
// directly because all deposits route through the coordinator vault (#850).
function isRoutable(vault: ApiVault, _opts?: RouteOptions): boolean {
  return vault.protocol === "meridian";
}

/**
 * Pick the vault to route a new deposit into: the highest-APY vault Meridian can
 * actually build a deposit for (a Meridian coordinator vault), preferring pools
 * not flagged "risky". Falls back to the best routable pool when every option is
 * risky, and returns null when nothing is routable. Pure — no I/O.
 */
export function selectBestVault(
  vaults: ApiVault[],
  opts?: RouteOptions
): ApiVault | null {
  const routable = vaults.filter((v) => isRoutable(v, opts));
  if (routable.length === 0) return null;

  const safe = routable.filter((v) => v.riskLevel !== "risky");
  const candidates = safe.length > 0 ? safe : routable;

  // Tie-break by id (alphabetical) so the result is stable across requests.
  return candidates.reduce((best, v) =>
    v.apy > best.apy || (v.apy === best.apy && v.id < best.id) ? v : best
  );
}
