import { useQuery } from "@tanstack/react-query";
import { api, type PositionSnapshot } from "../lib/api";

export function usePositionHistory(publicKey: string | null, days: number) {
  return useQuery<PositionSnapshot[], Error>({
    queryKey: ["positionHistory", publicKey, days],
    queryFn: async () => {
      if (!publicKey) throw new Error("No public key");
      const data = await api.getPositionHistory(publicKey, days);
      return data.snapshots;
    },
    enabled: !!publicKey,
    // Snapshots are captured at most every 30 minutes server-side.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
