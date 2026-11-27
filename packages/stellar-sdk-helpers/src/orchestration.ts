import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { toBigInt } from "./internal";
import { simulateView, toStroops } from "./tx";
import {
  buildCoordinatorDepositTx,
  buildCoordinatorWithdrawTx,
  fetchCoordinatorPosition,
} from "./coordinator";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";
import { KNOWN_POOLS } from "./known-pools";
import { getRpcServer } from "./internal";

/**
 * Look up the registry entry for `vaultId` on the given network. Throws if the
 * vault is unknown or its contract address is not yet configured.
 */
function resolveVaultEntry(vaultId: string, network: StellarNetwork) {
  const pools =
    network.network === "testnet" ? KNOWN_POOLS.testnet : KNOWN_POOLS.mainnet;
  const entry = Object.values(pools).find((p) => p.id === vaultId);
  if (!entry) {
    throw new Error(`Vault not found: ${vaultId}`);
  }
  if (entry.protocol !== "meridian") {
    throw new Error("Only Meridian vaults supported");
  }
  if (!entry.contractId) {
    throw new Error(`Vault not deployed: ${vaultId} has no contractId`);
  }
  return { ...entry, contractId: entry.contractId };
}

/**
 * Build an unsigned deposit transaction for the coordinator vault identified
 * by `vaultId`. All deposits route through the coordinator regardless of the
 * underlying protocol; the active adapter handles protocol-specific logic.
 * `minSharesOut` is the minimum mUSDC shares the caller is willing to receive;
 * the vault rejects the call with `SlippageExceeded` if minted shares fall below it.
 * Defaults to `"0"` (no slippage protection) when omitted.
 */
export async function buildDepositTx(
  vaultId: string,
  walletAddress: string,
  amount: string,
  network: StellarNetwork,
  minSharesOut: string = "0"
): Promise<{ xdr: string; fee: string }> {
  const entry = resolveVaultEntry(vaultId, network);
  return buildCoordinatorDepositTx(
    { contractId: entry.contractId, network },
    walletAddress,
    toStroops(amount),
    toStroops(minSharesOut)
  );
}

/**
 * Build an unsigned withdrawal transaction for the coordinator vault identified
 * by `vaultId`. `shares` is the mUSDC share count to burn. `minUsdcOut` is the
 * minimum USDC the caller is willing to receive; the vault rejects the call
 * with `MinAmountOutNotMet` if the redeemed amount falls below it. Defaults to
 * `"0"` (no slippage protection) when omitted.
 */
export async function buildWithdrawTx(
  vaultId: string,
  walletAddress: string,
  shares: string,
  network: StellarNetwork,
  minUsdcOut: string = "0"
): Promise<{ xdr: string; fee: string }> {
  const entry = resolveVaultEntry(vaultId, network);
  return buildCoordinatorWithdrawTx(
    { contractId: entry.contractId, network },
    walletAddress,
    toStroops(shares),
    toStroops(minUsdcOut)
  );
}

/**
 * Fetches all positions for `publicKey` across every registered coordinator
 * vault on the given network. Failures from any single vault are logged and
 * suppressed so partial results are always returned.
 *
 * Because a failed read is indistinguishable from an empty position in the
 * returned list, pass `onVaultError` when the caller must tell the two apart
 * (for example before writing a snapshot that would otherwise record zero).
 */
export async function resolvePositions(
  publicKey: string,
  network: StellarNetwork,
  options: { onVaultError?: (error: unknown) => void } = {}
): Promise<PositionInfo[]> {
  const pools = Object.values(
    network.network === "testnet" ? KNOWN_POOLS.testnet : KNOWN_POOLS.mainnet
  ).filter(
    (p): p is typeof p & { contractId: string } =>
      p.protocol === "meridian" && Boolean(p.contractId)
  );

  const results = await Promise.allSettled(
    pools.map((p) =>
      fetchCoordinatorPosition(
        { contractId: p.contractId, network },
        p.id,
        publicKey
      )
    )
  );

  const positions: PositionInfo[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      positions.push(...result.value);
    } else {
      console.error("[positions] fetch failed:", result.reason);
      options.onVaultError?.(result.reason);
    }
  }
  return positions;
}

export interface TransactionQuote {
  action: "deposit" | "withdraw";
  expectedShares?: string;
  expectedAssets?: string;
  fee: string;
  ledger: number;
  recommendedMinimum: string;
  slippageBps: number;
}

function i128(value: bigint) {
  return nativeToScVal(value, { type: "i128" });
}

export async function quoteVaultAction(options: {
  vaultId: string;
  walletAddress: string;
  action: "deposit" | "withdraw";
  amount?: string | undefined;
  shares?: string | undefined;
  network: StellarNetwork;
  slippageBps: number;
}): Promise<TransactionQuote> {
  if (
    !Number.isInteger(options.slippageBps) ||
    options.slippageBps < 0 ||
    options.slippageBps > 10_000
  ) {
    throw new Error("slippageBps must be between 0 and 10000");
  }
  const entry = resolveVaultEntry(options.vaultId, options.network);
  const server = getRpcServer(options.network.rpcUrl, 12_000);

  if (options.action === "deposit") {
    if (!options.amount)
      throw new Error("amount is required for deposit quotes");
    const amount = toStroops(options.amount);
    const paused = Boolean(
      await simulateView(
        server,
        entry.contractId,
        options.network.passphrase,
        "is_paused"
      )
    );
    if (paused) throw new Error("Deposits are currently paused");
    const result = await simulateView(
      server,
      entry.contractId,
      options.network.passphrase,
      "preview_deposit",
      i128(amount)
    );
    const expected = toBigInt(result);
    const recommended =
      (expected * BigInt(10_000 - options.slippageBps)) / 10_000n;
    const latest = await server.getLatestLedger();
    return {
      action: "deposit",
      expectedShares: formatStroops(expected),
      recommendedMinimum: formatStroops(recommended),
      slippageBps: options.slippageBps,
      fee: "0",
      ledger: latest.sequence,
    };
  }

  if (!options.shares)
    throw new Error("shares is required for withdrawal quotes");
  const shares = toStroops(options.shares);
  const result = (await simulateView(
    server,
    entry.contractId,
    options.network.passphrase,
    "preview_withdraw",
    Address.fromString(options.walletAddress).toScVal(),
    i128(shares)
  )) as Record<string, unknown>;
  const assetsOut = toBigInt(result.assets_out);
  const performanceFee = toBigInt(result.fee);
  const recommended =
    (assetsOut * BigInt(10_000 - options.slippageBps)) / 10_000n;
  const latest = await server.getLatestLedger();
  return {
    action: "withdraw",
    expectedAssets: formatStroops(assetsOut),
    fee: formatStroops(performanceFee),
    recommendedMinimum: formatStroops(recommended),
    slippageBps: options.slippageBps,
    ledger: latest.sequence,
  };
}

function formatStroops(value: bigint): string {
  const whole = value / 10_000_000n;
  const remainder = value % 10_000_000n;
  if (remainder === 0n) return whole.toString();
  return `${whole}.${remainder.toString().padStart(7, "0").replace(/0+$/, "")}`;
}

/** Returns the latest closed ledger sequence for the given network. */
export async function getLatestLedgerSequence(
  network: StellarNetwork
): Promise<number> {
  const server = getRpcServer(network.rpcUrl, 12_000);
  const latest = await server.getLatestLedger();
  return latest.sequence;
}
