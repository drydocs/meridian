import {
  Contract,
  TransactionBuilder,
  Address,
  Asset,
  Operation,
  Horizon,
  nativeToScVal,
  rpc,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";

const VAULT_CONTRACT_ID = process.env.VAULT_CONTRACT_ID ?? "CBK5RI4BCA7TLSD2S5Q5TH2LUQAT55GF34OBTWPFUKWZ5O6YXSQDAWOJ";
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "100";

// Testnet USDC issued by Circle.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ASSET = new Asset("USDC", USDC_ISSUER);

// mUSDC share token issued by the musdc-issuer key generated at deployment.
const MUSDC_ISSUER = "GAZOB5KAE27U7QMGCJLA74TKGECONNND73GL2GIMYBXYNBVG4U5IHBX7";
const MUSDC_ASSET = new Asset("MUSDC", MUSDC_ISSUER);

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


function hasTrustlineInBalances(
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

async function assertTrustlines(walletAddress: string): Promise<void> {
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(walletAddress);
  const balances = account.balances;

  if (!hasTrustlineInBalances(balances, "USDC", USDC_ISSUER)) {
    throw new Error("Trustline missing — add the vault assets to your wallet before depositing");
  }
  if (!hasTrustlineInBalances(balances, "MUSDC", MUSDC_ISSUER)) {
    throw new Error("Trustline missing — add the vault assets to your wallet before depositing");
  }
}

export async function buildTrustlineXdr(walletAddress: string): Promise<{ xdr: string }> {
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(walletAddress);
  const balances = account.balances;

  const ops: ReturnType<typeof Operation.changeTrust>[] = [];
  if (!hasTrustlineInBalances(balances, "USDC", USDC_ISSUER)) ops.push(Operation.changeTrust({ asset: USDC_ASSET }));
  if (!hasTrustlineInBalances(balances, "MUSDC", MUSDC_ISSUER)) ops.push(Operation.changeTrust({ asset: MUSDC_ASSET }));

  if (ops.length === 0) throw new Error("All required trustlines already exist");

  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(300).build();

  return { xdr: tx.toEnvelope().toXDR("base64") };
}

export async function buildDepositXdr(
  walletAddress: string,
  vaultId: string,
  amount: string
): Promise<{ xdr: string; fee: string }> {
  if (!VAULT_CONTRACT_ID) throw new Error("Vault contract not yet deployed");

  await assertTrustlines(walletAddress);

  const protocol = resolveProtocol(vaultId);
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(VAULT_CONTRACT_ID);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
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

export async function buildWithdrawXdr(
  walletAddress: string,
  shares: string
): Promise<{ xdr: string; fee: string }> {
  if (!VAULT_CONTRACT_ID) throw new Error("Vault contract not yet deployed");

  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(walletAddress);
  const contract = new Contract(VAULT_CONTRACT_ID);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
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

export async function submitSignedXdr(signedXdr: string): Promise<{ hash: string }> {
  const server = new rpc.Server(RPC_URL);
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const result = await server.sendTransaction(tx);
  if (result.status === "ERROR") throw new Error(`Transaction rejected (${result.status})`);
  return { hash: result.hash };
}
