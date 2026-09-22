import { useQuery } from "@tanstack/react-query";
import { api, type ApiPosition } from "../lib/api";

export function usePositions(publicKey: string | null) {
  return useQuery<ApiPosition[], Error>({
    queryKey: ["positions", publicKey],
    queryFn: async () => {
      if (!publicKey) throw new Error("No public key");
      const data = await api.getPositions(publicKey);
      return data.positions;
    },
    enabled: !!publicKey,
    staleTime: 30_000, // 30s: positions change on every deposit/withdraw
    retry: 1,
  });
}
