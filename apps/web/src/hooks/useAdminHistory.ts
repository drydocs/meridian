import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useWalletStore } from "../store/wallet";

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
  const publicKey = useWalletStore((state) => state.publicKey);
  return useQuery({
    queryKey: ["adminHistory", vaultId, publicKey],
    queryFn: () => api.getAdminHistory(vaultId!, publicKey!),
    enabled: Boolean(vaultId && publicKey),
    staleTime: 30_000,
    retry: 1,
  });
}
