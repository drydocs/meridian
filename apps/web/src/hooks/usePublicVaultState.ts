import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function usePublicVaultState() {
  return useQuery({
    queryKey: ["vault-state", "public"],
    queryFn: () => api.getPublicVaultState(),
    staleTime: 30_000,
    retry: 1,
  });
}
