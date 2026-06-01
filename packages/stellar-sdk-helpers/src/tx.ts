import {
  Contract,
  TransactionBuilder,
  Address,
  Asset,
  Horizon,
  Operation,
  nativeToScVal,
  rpc,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";

const USDC_ISSUER_TESTNET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ASSET_TESTNET = new Asset("USDC", USDC_ISSUER_TESTNET);

const BASE_FEE = "100";

function toStroops(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

function resolveProtocol(vaultId: string): "Blend" | "DeFindex" {
  if (vaultId.startsWith("blend-")) return "Blend";
  if (vaultId.startsWith("defindex-")) return "DeFindex";
  throw new Error(`No protocol mapping for vault: ${vaultId}`);
}

export async function buildAddTrustlineTx(
  walletAddress: string,
  network: StellarNetwork
): Promise<{ xdr: string }> {
  const horizonUrl = network.network === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
  const passphrase = network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  const asset = network.network === "mainnet" ? USDC_ASSET_TESTNET : USDC_ASSET_TESTNET;

  const horizon = new Horizon.Server(horizonUrl);
  const account = await horizon.loadAccount(walletAddress);

  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(300)
    .build();

  return { xdr: tx.toEnvelope().toXDR("base64") };
}

export async function buildDepositTx(
  contractId: string,
  walletAddress: string,
  vaultId: string,
  amount: string,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  const protocol = resolveProtocol(vaultId);
  const passphrase = network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  const server = new rpc.Server(network.rpcUrl);
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(
      contract.call(
        "deposit",
        Address.fromString(walletAddress).toScVal(),
        nativeToScVal(toStroops(amount), { type: "i128" }),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(protocol)]),
      )
    )
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`);

  const prepared = rpc.assembleTransaction(tx, sim).build();
  return { xdr: prepared.toEnvelope().toXDR("base64"), fee: sim.minResourceFee };
}

export async function buildWithdrawTx(
  contractId: string,
  walletAddress: string,
  shares: string,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  const passphrase = network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  const server = new rpc.Server(network.rpcUrl);
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(
      contract.call(
        "withdraw",
        Address.fromString(walletAddress).toScVal(),
        nativeToScVal(toStroops(shares), { type: "i128" }),
      )
    )
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`Simulation failed: ${sim.error}`);

  const prepared = rpc.assembleTransaction(tx, sim).build();
  return { xdr: prepared.toEnvelope().toXDR("base64"), fee: sim.minResourceFee };
}

export async function submitTx(
  signedXdr: string,
  network: StellarNetwork
): Promise<{ hash: string }> {
  const passphrase = network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(network.rpcUrl);
  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  const result = await server.sendTransaction(tx);
  if (result.status === "ERROR") throw new Error(`Transaction rejected (${result.status})`);
  return { hash: result.hash };
}
