import {
  Account,
  Contract,
  TransactionBuilder,
  Address,
  Asset,
  Horizon,
  Operation,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";
import { BASE_FEE } from "./internal";

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
    throw new Error("USDC trustline missing. Add vault assets to your wallet before depositing.");
  }
  if (MUSDC_ISSUER[network.network] && !hasAssetTrustline(account.balances, "MUSDC", MUSDC_ISSUER[network.network])) {
    throw new Error("mUSDC trustline missing. Add vault assets to your wallet before depositing.");
  }
}

export function toStroops(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

export function resolveProtocol(vaultId: string): "Blend" | "DeFindex" {
  if (vaultId.startsWith("blend-")) return "Blend";
  if (vaultId.startsWith("defindex-")) return "DeFindex";
  throw new Error(`No protocol mapping for vault: ${vaultId}`);
}

export async function simulateView(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const dummyAccount = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", "0");
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(dummyAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval);
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

// Default polling cadence for confirmation. Soroban testnet/mainnet close
// ledgers roughly every 5s, so a 1s poll lands the result within one ledger of
// inclusion, and 60s comfortably outlasts a few ledger closes before giving up.
const CONFIRM_POLL_INTERVAL_MS = 1_000;
const CONFIRM_TIMEOUT_MS = 60_000;

export interface SubmitResult {
  hash: string;
  status: "SUCCESS";
  ledger: number;
}

export interface ConfirmOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  // Injection seams so the polling loop is unit-testable without real timers.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// The slice of rpc.Server the confirmation loop needs. Narrowing it lets tests
// pass a hand-rolled fake without constructing a real Server.
interface TransactionReader {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `getTransaction` until the network reports a final status. Resolves on
 * SUCCESS, throws on FAILED, and throws on timeout while the transaction is
 * still NOT_FOUND (i.e. accepted into the mempool but not yet included). Pure
 * with respect to time via the injectable `sleep`/`now` seams.
 */
export async function waitForTransaction(
  server: TransactionReader,
  hash: string,
  opts: ConfirmOptions = {}
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const pollIntervalMs = opts.pollIntervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const deadline = now() + timeoutMs;

  for (;;) {
    const res = await server.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return res;
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${hash} failed on-chain`);
    }
    // NOT_FOUND: still propagating; keep polling until the deadline.
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for transaction ${hash} to confirm`);
    }
    await sleep(pollIntervalMs);
  }
}

// Best-effort decode of the result code the RPC returns on a rejected submit
// (e.g. txInsufficientBalance), without letting an unexpected XDR shape throw.
function describeSendError(res: rpc.Api.SendTransactionResponse): string {
  try {
    return res.errorResult?.result().switch().name ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

/**
 * Submit a signed transaction and wait for it to actually land. Rejection at
 * submission time (ERROR / TRY_AGAIN_LATER) throws immediately; PENDING and
 * DUPLICATE are polled to a final on-chain status so a resolved promise always
 * means the transaction succeeded.
 */
export async function submitTx(
  signedXdr: string,
  network: StellarNetwork,
  opts: ConfirmOptions = {}
): Promise<SubmitResult> {
  const passphrase = network.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  const server = new rpc.Server(network.rpcUrl);
  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);

  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`Transaction rejected at submission: ${describeSendError(sent)}`);
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error("Transaction could not be submitted yet (try again later)");
  }

  // PENDING or DUPLICATE: the transaction is in (or already passed through) the
  // mempool under this hash, so wait for the ledger to record its outcome.
  const confirmed = await waitForTransaction(server, sent.hash, opts);
  return { hash: sent.hash, status: "SUCCESS", ledger: confirmed.ledger };
}
