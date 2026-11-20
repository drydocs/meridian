import type { ApiVault, PositionInfo } from "@meridian/stellar-sdk-helpers";

export type { ApiVault };
export type ApiPosition = PositionInfo;

export interface KeeperHealthEntry {
  id: "accrual" | "migration";
  intervalMs: number;
  lastSuccessMs: number | null;
  healthy: boolean;
}

export interface VaultSnapshot {
  vaultId: string;
  protocol: string;
  value: number;
  earned: number;
}

export interface PositionSnapshot {
  /** Capture time, epoch ms. */
  timestamp: number;
  totalValue: number;
  totalEarned: number;
  vaults: VaultSnapshot[];
}

export interface VaultState {
  protocol: string;
  adapterId: string;
  totalShares: number;
  totalAssets: number;
  paused: boolean;
}

/**
 * Error raised for non-OK HTTP responses. `status` lets callers distinguish
 * client errors (4xx, never retried) from server or network failures.
 */
export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when the error represents a client error that must not be retried. */
export function isClientError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

/**
 * True when the failure looks like connectivity loss: either a fetch-level
 * TypeError (no HTTP response) or a timeout/abort.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === null;
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  return false;
}

const API_BASE = import.meta.env.VITE_API_URL ?? "";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    let msg = res.statusText;
    if (body !== null && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.error === "string") {
        msg = b.error;
      } else if (typeof b.error === "object" && b.error !== null) {
        const errObj = b.error as Record<string, unknown>;
        if (typeof errObj.message === "string") {
          msg = errObj.message;
        }
      } else if (typeof b.message === "string") {
        msg = b.message;
      }
    }
    msg = msg || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getVaults: () =>
    apiFetch<{
      vaults: ApiVault[];
      recommendedVaultId: string | null;
      updatedAt: string;
      cached: boolean;
    }>("/api/v1/vaults"),
  getPositions: (publicKey: string) =>
    apiFetch<{ positions: ApiPosition[] }>(`/api/v1/positions/${publicKey}`),
  getPositionHistory: (publicKey: string, days: number) =>
    apiFetch<{
      publicKey: string;
      days: number;
      snapshots: PositionSnapshot[];
    }>(`/api/v1/positions/${publicKey}/history?days=${days}`),
  addTrustline: (walletAddress: string) =>
    apiFetch<{ xdr: string }>("/api/v1/tx/add-trustline", {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    }),
  buildDeposit: (body: {
    walletAddress: string;
    vaultId: string;
    amount: string;
    min_shares_out?: string;
    riskAcknowledged: true;
  }) =>
    apiFetch<{ xdr: string; fee: string }>("/api/v1/tx/deposit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  buildWithdraw: (body: {
    walletAddress: string;
    vaultId: string;
    shares: string;
    min_usdc_out?: string;
  }) =>
    apiFetch<{ xdr: string; fee: string }>("/api/v1/tx/withdraw", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  submitTx: (body: { xdr: string }) =>
    apiFetch<{ hash: string }>("/api/v1/tx/submit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getKeeperHealth: () =>
    apiFetch<{ keepers: KeeperHealthEntry[]; checkedAt: string }>(
      "/api/v1/keepers/health"
    ),
  getVaultState: () => apiFetch<VaultState>("/api/v1/admin/vault-state"),
  getAdminHistory: (vaultId: string) =>
    apiFetch<{
      vaultId: string;
      contractId: string;
      actions: Array<{
        id: string;
        type: string;
        timestamp: string;
        transactionHash: string;
        sourceAccount: string;
        summary: string;
        details: Record<string, unknown>;
      }>;
      updatedAt: string;
    }>(`/api/v1/admin/history?vaultId=${encodeURIComponent(vaultId)}`),
};
