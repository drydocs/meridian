const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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

export const api = {
  getVaults: () => apiFetch<{ vaults: unknown[] }>("/api/v1/vaults"),
  getVault: (id: string) => apiFetch<unknown>(`/api/v1/vaults/${id}`),
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
