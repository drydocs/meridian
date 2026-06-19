import { Networks } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

export const BASE_FEE = "100";

export const STROOPS_PER_UNIT = 1e7;

export function toBigInt(value: unknown): bigint {
  return BigInt((value as bigint | number | null) ?? 0);
}

export function passphraseFor(network: StellarNetwork): string {
  return network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}
