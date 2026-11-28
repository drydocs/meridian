import { useQuery } from "@tanstack/react-query";
import { api, isClientError, type ApiVault } from "../lib/api";

export interface VaultsResult {
  vaults: ApiVault[];
  // Server-chosen best routable vault (highest APY among depositable, non-risky
  // pools), or null when nothing is routable.
  recommendedVaultId: string | null;
}

export function useVaults() {
  return useQuery<VaultsResult, Error>({
    queryKey: ["vaults"],
    queryFn: async () => {
      const data = await api.getVaults();
      return {
        vaults: data.vaults,
        recommendedVaultId: data.recommendedVaultId,
      };
    },
    staleTime: 5 * 60_000,
    retry: (failureCount, error) => !isClientError(error) && failureCount < 1,
  });
}
