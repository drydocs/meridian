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

const USDC_ISSUER: Record<string, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

// mUSDC is the vault's share token. Issuer = the musdc-issuer key used during deployment.
const MUSDC_ISSUER: Record<string, string> = {
  testnet: "GAZOB5KAE27U7QMGCJLA74TKGECONNND73GL2GIMYBXYNBVG4U5IHBX7",
  mainnet: "",
};

const HORIZON_URL: Record<string, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

const BASE_FEE = "100";

function usdcAsset(network: StellarNetwork): Asset {
  const issuer = USDC_ISSUER[network.network];
  if (!issuer) throw new Error(`No USDC issuer for network: ${network.network}`);
  return new Asset("USDC", issuer);
}

function musdcAsset(network: StellarNetwork): Asset {
  const issuer = MUSDC_ISSUER[network.network];
  if (!issuer) throw new Error(`No mUSDC issuer for network: ${network.network}`);
  return new Asset("MUSDC", issuer);
}

function horizonServer(network: StellarNetwork): Horizon.Server {
  return new Horizon.Server(HORIZON_URL[network.network] ?? HORIZON_URL.testnet);
}

function hasAssetTrustline(
  balances: Horizon.HorizonApi.BalanceLine[],
  code: string,
  issuer: string
): boolean {
  return balances.some(
    (b) =>
      (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
      (b as Horizon.HorizonApi.BalanceLine<"credit_alphanum4">).asset_code === code &&
      (b as Horizon.HorizonApi.BalanceLine<"credit_alphanum4">).asset_issuer === issuer
  );
}

async function assertTrustlines(walletAddress: string, network: StellarNetwork): Promise<void> {
  const horizon = horizonServer(network);
  const account = await horizon.loadAccount(walletAddress);

  if (!hasAssetTrustline(account.balances, "USDC", USDC_ISSUER[network.network] ?? "")) {
    throw new Error("USDC trustline missing — add the vault assets to your wallet before depositing");
  }
  if (MUSDC_ISSUER[network.network] && !hasAssetTrustline(account.balances, "MUSDC", MUSDC_ISSUER[network.network])) {
    throw new Error("mUSDC trustline missing — add the vault assets to your wallet before depositing");
  }
}

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
  const passphrase = network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  const horizon = horizonServer(network);
  const account = await horizon.loadAccount(walletAddress);
  const balances = account.balances;

  const ops: ReturnType<typeof Operation.changeTrust>[] = [];

  if (!hasAssetTrustline(balances, "USDC", USDC_ISSUER[network.network] ?? "")) {
    ops.push(Operation.changeTrust({ asset: usdcAsset(network) }));
  }
  if (MUSDC_ISSUER[network.network] && !hasAssetTrustline(balances, "MUSDC", MUSDC_ISSUER[network.network])) {
    ops.push(Operation.changeTrust({ asset: musdcAsset(network) }));
  }

  if (ops.length === 0) throw new Error("All required trustlines already exist");

  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(300).build();

  return { xdr: tx.toEnvelope().toXDR("base64") };
}

export async function buildDepositTx(
  contractId: string,
  walletAddress: string,
  vaultId: string,
  amount: string,
  network: StellarNetwork
): Promise<{ xdr: string; fee: string }> {
  await assertTrustlines(walletAddress, network);

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
