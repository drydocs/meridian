import { rpc, Address, xdr } from "@stellar/stellar-sdk";
import { simulateView } from "./tx";
import type { StellarNetwork } from "./types";
import { STROOPS_PER_UNIT, toBigInt } from "./internal";

export interface PositionInfo {
  vaultId: string;
  shares: number;
  deposited: number;
  earned: number;
  entryTime: number;
}

// Raw i128/u64 figures read from the vault contract, in stroops (7 decimals).
export interface RawPosition {
  shares: bigint;
  totalShares: bigint;
  totalAssets: bigint;
  // Cost basis from get_principal. null when the deployed contract predates
  // principal tracking — earned then falls back to 0 rather than guessing.
  principal: bigint | null;
  entryTime: bigint;
}

/**
 * Derive the display position from raw on-chain figures. Pure and total — no
 * I/O — so the share-value and earned math is unit-testable in isolation.
 *
 *   currentValue = shares * totalAssets / totalShares   (value of the holding)
 *   earned       = max(0, currentValue − principal)     (yield accrued)
 *
 * Returns an empty array when the address holds no shares.
 */
export function computePosition(vaultId: string, raw: RawPosition): PositionInfo[] {
  if (raw.shares <= 0n) return [];

  const currentValue =
    raw.totalShares > 0n ? (raw.shares * raw.totalAssets) / raw.totalShares : 0n;

  const earned =
    raw.principal !== null && currentValue > raw.principal ? currentValue - raw.principal : 0n;

  return [
    {
      vaultId,
      shares: Number(raw.shares) / STROOPS_PER_UNIT,
      deposited: Number(currentValue) / STROOPS_PER_UNIT,
      earned: Number(earned) / STROOPS_PER_UNIT,
      entryTime: Number(raw.entryTime),
    },
  ];
}

/**
 * Read an address's vault position via read-only contract simulation. Returns
 * `[]` if the address holds nothing. `get_principal` is fetched defensively so
 * the call still succeeds against a vault deployed before principal tracking
 * existed (earned simply reads 0 until the contract is upgraded).
 */
export async function fetchPosition(
  network: StellarNetwork,
  vaultContractId: string,
  publicKey: string
): Promise<PositionInfo[]> {
  const server = new rpc.Server(network.rpcUrl);
  const caller = Address.fromString(publicKey).toScVal();
  const view = (method: string, ...args: xdr.ScVal[]) =>
    simulateView(server, vaultContractId, network.passphrase, method, ...args);

  const [shares, totalShares, totalAssets, entryTime] = await Promise.all([
    view("get_position", caller),
    view("get_total_shares"),
    view("get_total_assets"),
    view("get_entry_time", caller),
  ]);

  let principal: bigint | null;
  try {
    principal = toBigInt(await view("get_principal", caller));
  } catch {
    principal = null;
  }

  return computePosition(vaultContractId, {
    shares: toBigInt(shares),
    totalShares: toBigInt(totalShares),
    totalAssets: toBigInt(totalAssets),
    principal,
    entryTime: toBigInt(entryTime),
  });
}
