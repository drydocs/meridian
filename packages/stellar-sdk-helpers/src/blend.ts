import { Networks, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { PoolContractV2, PoolV2, RequestType } from "@blend-capital/blend-sdk";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";

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

export interface BlendReserveRef {
  // Reserve asset contract (the USDC/EURC Stellar Asset Contract).
  assetId: string;
  // Meridian vault id the resulting position is reported under.
  vaultId: string;
}

/**
 * Read a user's live supply position in a Blend pool, one entry per reserve the
 * user holds. The pool ledger state is loaded once and each reserve is valued
 * via the SDK (collateral + plain supply, in underlying asset units).
 *
 * `deposited` is the current value of the position; `shares` mirrors it so the
 * UI's "withdraw max" reflects the full withdrawable amount. `earned` is 0 for
 * now — a direct Blend supply carries no on-chain cost basis, so yield can't be
 * derived without event indexing (tracked separately).
 */
export async function fetchBlendPositions(
  network: StellarNetwork,
  poolId: string,
  publicKey: string,
  reserves: BlendReserveRef[]
): Promise<PositionInfo[]> {
  const pool = await PoolV2.load({ rpc: network.rpcUrl, passphrase: network.passphrase }, poolId);
  const user = await pool.loadUser(publicKey);

  const positions: PositionInfo[] = [];
  for (const { assetId, vaultId } of reserves) {
    const reserve = pool.reserves.get(assetId);
    if (!reserve) continue;
    const value = user.getCollateralFloat(reserve) + user.getSupplyFloat(reserve);
    if (value <= 0) continue;
    positions.push({ vaultId, shares: value, deposited: value, earned: 0, entryTime: 0 });
  }
  return positions;
}
