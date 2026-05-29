import { useQuery } from "@tanstack/react-query";
import { api, type ApiVault } from "../lib/api";

export function useVaults() {
  return useQuery<ApiVault[], Error>({
    queryKey: ["vaults"],
    queryFn: async () => {
      const [data] = await Promise.all([
        api.getVaults(),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
      return data.vaults;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
