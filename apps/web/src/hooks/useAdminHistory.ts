import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { getAdminSessionToken } from "../lib/adminSession";

export interface AdminAction {
  id: string;
  type: string;
  timestamp: string;
  transactionHash: string;
  sourceAccount: string;
  summary: string;
  details: Record<string, unknown>;
}

export function useAdminHistory(vaultId: string | null) {
  const sessionToken = getAdminSessionToken();
  return useQuery({
    queryKey: ["adminHistory", vaultId, Boolean(sessionToken)],
    queryFn: () => api.getAdminHistory(vaultId!, sessionToken!),
    enabled: Boolean(vaultId && sessionToken),
    staleTime: 30_000,
    retry: 1,
  });
}
