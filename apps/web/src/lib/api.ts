const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "API error");
  }
  return res.json() as Promise<T>;
}

// JSON-safe vault shape (bigints serialised as numbers by the API)
export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex";
  asset: string;
  apy: number;
  tvl: number;
  userBalance: number;
}

export interface ApiPosition {
  vaultId: string;
  deposited: number;
  earned: number;
  entryTime: number;
}

export const api = {
  getVaults: () =>
    apiFetch<{ vaults: ApiVault[]; updatedAt: string; cached: boolean }>(
      "/api/v1/vaults"
    ),
  getVault: (id: string) => apiFetch<ApiVault>(`/api/v1/vaults/${id}`),
  getPositions: (publicKey: string) =>
    apiFetch<{ positions: ApiPosition[] }>(
      `/api/v1/positions/${publicKey}`
    ),
  buildDeposit: (body: unknown) =>
    apiFetch<{ xdr: string }>("/api/v1/tx/deposit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  buildWithdraw: (body: unknown) =>
    apiFetch<{ xdr: string }>("/api/v1/tx/withdraw", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
