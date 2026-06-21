import { Networks } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

export const BASE_FEE = "100";

export const STROOPS_PER_UNIT = 1e7;

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (value === null || value === undefined) return 0n;
  throw new TypeError(`toBigInt: unexpected type ${typeof value}: ${String(value)}`);
}

export function passphraseFor(network: StellarNetwork): string {
  return network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}
