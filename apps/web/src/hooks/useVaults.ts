import { useQuery } from "@tanstack/react-query";
import { api, type ApiVault } from "../lib/api";

export function useVaults() {
  return useQuery<ApiVault[], Error>({
    queryKey: ["vaults"],
    queryFn: async () => {
      const data = await api.getVaults();
      return data.vaults;
    },
    staleTime: 60_000,
    retry: 2,
  });
}
