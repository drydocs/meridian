import { Networks, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { PoolContractV2, RequestType } from "@blend-capital/blend-sdk";
import type { StellarNetwork } from "./types";

const BASE_FEE = "100";

export interface BlendPoolConfig {
  // Blend pool contract (C...) the request is submitted to.
  poolId: string;
  // Reserve asset contract — the USDC/EURC Stellar Asset Contract being moved.
  assetId: string;
  network: StellarNetwork;
}

function passphraseFor(network: StellarNetwork): string {
  return network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

// Map a Meridian vault id (e.g. "blend-usdc-fixed") to the reserve asset whose
// Stellar Asset Contract the deposit supplies. Pure so the routing is testable
// without touching the network.
export function blendAssetForVault(vaultId: string): "usdc" | "eurc" {
  if (vaultId.includes("-usdc")) return "usdc";
  if (vaultId.includes("-eurc")) return "eurc";
  throw new Error(`No Blend reserve asset mapped for vault: ${vaultId}`);
}

async function buildPoolRequestTx(
  config: BlendPoolConfig,
  caller: string,
  requestType: RequestType,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  if (amount <= 0n) throw new Error("amount must be positive");

  const passphrase = passphraseFor(config.network);
  const server = new rpc.Server(config.network.rpcUrl);
  const account = await server.getAccount(caller);

  // PoolContractV2.submit returns a base64 Soroban operation; we wrap it in a
  // transaction, simulate to obtain the resource footprint + fee, then assemble.
  const pool = new PoolContractV2(config.poolId);
  const opXdr = pool.submit({
    from: caller,
    spender: caller,
    to: caller,
    requests: [{ request_type: requestType, address: config.assetId, amount }],
  });
  const op = xdr.Operation.fromXDR(opXdr, "base64");

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`);

  const prepared = rpc.assembleTransaction(tx, sim).build();
  return { xdr: prepared.toEnvelope().toXDR("base64"), fee: sim.minResourceFee };
}

/**
 * Build an unsigned transaction that supplies `amount` (in stroops) of the
 * pool's reserve asset into a Blend pool as collateral on behalf of `depositor`.
 *
 * Non-custodial: the user's wallet signs the returned XDR and the frontend
 * submits it. The resulting bToken position is held by the user directly —
 * funds never pass through a Meridian-controlled contract. A missing USDC/EURC
 * trustline or balance surfaces as a simulation error.
 */
export function buildBlendDepositTx(
  config: BlendPoolConfig,
  depositor: string,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  return buildPoolRequestTx(config, depositor, RequestType.SupplyCollateral, amount);
}

/**
 * Build an unsigned transaction that withdraws `amount` (in stroops) of supplied
 * collateral back to `withdrawer`. Mirrors the deposit path; the user signs and
 * submits the returned XDR.
 */
export function buildBlendWithdrawTx(
  config: BlendPoolConfig,
  withdrawer: string,
  amount: bigint
): Promise<{ xdr: string; fee: string }> {
  return buildPoolRequestTx(config, withdrawer, RequestType.WithdrawCollateral, amount);
}
