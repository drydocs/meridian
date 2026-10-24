import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  Asset,
  Horizon,
  Operation,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./types";
import { BASE_FEE, passphraseFor, getRpcServer } from "./internal";
import {
  withRetry,
  withRaceTimeout,
  USDC_ISSUER,
  MUSDC_ISSUER,
  CONTRACT_ADDRESSES,
} from "@meridian/shared";
import { buildHorizonServer } from "./horizon";
import { KNOWN_POOLS } from "./known-pools";

// The Soroban RPC SDK does not surface an AbortSignal option, so we race each
// call against a manual timeout rejection. 10 s is enough for testnet under
// normal load; callers get a fast, actionable error instead of hanging until
// the Vercel function-level deadline fires.
const SOROBAN_RPC_TIMEOUT_MS = 10_000;

export class SorobanTimeoutError extends Error {
  constructor(ms: number) {
    super(`Soroban RPC timed out after ${ms}ms`);
    this.name = "SorobanTimeoutError";
  }
}

/** A recognized contract rejection, distinct from an RPC/server failure. */
export class ContractSimulationError extends Error {
  constructor(
    readonly code: number,
    readonly cause: string
  ) {
    super(`Simulation failed: ${simErrorMessage(cause)}`);
    this.name = "ContractSimulationError";
  }
}

const withSorobanTimeout = <T>(
  fn: () => Promise<T>,
  ms = SOROBAN_RPC_TIMEOUT_MS
): Promise<T> =>
  withRaceTimeout(fn, ms, "Soroban RPC").catch((err: unknown): never => {
    if (err instanceof Error && err.message.includes("timed out"))
      throw new SorobanTimeoutError(ms);
    throw err;
  });

function usdcAsset(network: StellarNetwork): Asset {
  const issuer = USDC_ISSUER[network.network];
  if (!issuer)
    throw new Error(`No USDC issuer for network: ${network.network}`);
  return new Asset("USDC", issuer);
}

function musdcAsset(network: StellarNetwork): Asset {
  const issuer = MUSDC_ISSUER[network.network];
  if (!issuer)
    throw new Error(`No mUSDC issuer for network: ${network.network}`);
  return new Asset("MUSDC", issuer);
}

function horizonServer(network: StellarNetwork): Horizon.Server {
  return buildHorizonServer(network);
}

function hasAssetTrustline(
  balances: Horizon.HorizonApi.BalanceLine[],
  code: string,
  issuer: string
): boolean {
  return balances.some(
    (b) =>
      (b.asset_type === "credit_alphanum4" ||
        b.asset_type === "credit_alphanum12") &&
      (b as Horizon.HorizonApi.BalanceLine<"credit_alphanum4">).asset_code ===
        code &&
      (b as Horizon.HorizonApi.BalanceLine<"credit_alphanum4">).asset_issuer ===
        issuer
  );
}

/**
 * Raised when a wallet is missing a classic USDC/mUSDC trustline required
 * for deposit/withdraw. Callers should map this to HTTP 400 so direct API
 * clients get an actionable error instead of a simulation 500.
 */
export class MissingTrustlineError extends Error {
  constructor(readonly missing: string[]) {
    const list = missing.join(", ");
    super(
      missing.length === 1
        ? `Missing ${list} trustline. Add the trustline via POST /api/v1/tx/add-trustline before depositing or withdrawing.`
        : `Missing required trustlines: ${list}. Add them via POST /api/v1/tx/add-trustline before depositing or withdrawing.`
    );
    this.name = "MissingTrustlineError";
  }
}

/**
 * Query Horizon for the wallet's classic balances and throw {@link MissingTrustlineError} if any required USDC/mUSDC trustline is
 * absent. Networks where `MUSDC_ISSUER` is empty (SEP-41 cutover) skip the
 * mUSDC check. An account that does not yet exist on Horizon is treated as
 * missing every required trustline.
 */
export async function assertRequiredTrustlines(
  walletAddress: string,
  network: StellarNetwork
): Promise<void> {
  const horizon = horizonServer(network);
  let balances: Horizon.HorizonApi.BalanceLine[];
  try {
    const account = await horizon.loadAccount(walletAddress);
    balances = account.balances;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) {
      const missing: string[] = [];
      if (USDC_ISSUER[network.network]) missing.push("USDC");
      if (MUSDC_ISSUER[network.network]) missing.push("MUSDC");
      throw new MissingTrustlineError(missing.length ? missing : ["USDC"]);
    }
    throw err;
  }

  const missing: string[] = [];
  const usdcIssuer = USDC_ISSUER[network.network];
  if (usdcIssuer && !hasAssetTrustline(balances, "USDC", usdcIssuer)) {
    missing.push("USDC");
  }
  const musdcIssuer = MUSDC_ISSUER[network.network];
  if (musdcIssuer && !hasAssetTrustline(balances, "MUSDC", musdcIssuer)) {
    missing.push("MUSDC");
  }
  if (missing.length > 0) throw new MissingTrustlineError(missing);
}

/** Convert a decimal string (up to 7 fractional digits) to stroops as a bigint. */
export function toStroops(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded);
}

/**
 * Execute a read-only Soroban contract call via simulation and return the
 * decoded native value. Returns `null` when the simulation succeeds but
 * produces no return value. Throws on simulation errors.
 */
export async function simulateView(
  server: rpc.Server,
  contractId: string,
  networkPassphrase: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const dummyAccount = new Account(
    "GBBD47IF6LWK7P7MDEVMCWR7DPUWV3NY3DTQEVFL4N4HA4AQHZ3LLFLA5",
    "0"
  );
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();
  const sim = await withSorobanTimeout(() => server.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim))
    throw new Error(simErrorMessage(sim.error));
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval);
}

/**
 * Fetch the caller's account, simulate the operation to obtain the resource
 * footprint and fee, assemble the transaction, and return the unsigned XDR
 * and minimum resource fee. Throws if simulation fails.
 */
export async function prepareSorobanTx(
  network: StellarNetwork,
  caller: string,
  op: xdr.Operation
): Promise<{ xdr: string; fee: string }> {
  const passphrase = passphraseFor(network);
  const server = getRpcServer(network.rpcUrl, 8_000);
  const account = await withRetry(
    () => withSorobanTimeout(() => server.getAccount(caller)),
    3,
    200,
    (err) => !(err instanceof SorobanTimeoutError)
  );
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();
  const sim = await withSorobanTimeout(() => server.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) {
    const code = leadingContractErrorCode(sim.error);
    if (code !== undefined && VAULT_CONTRACT_ERROR_MESSAGES[code]) {
      throw new ContractSimulationError(code, sim.error);
    }
    const error = new Error(
      `Simulation failed: ${simErrorMessage(sim.error)}`
    ) as Error & { cause?: unknown };
    error.cause = sim.error;
    throw error;
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  return {
    xdr: prepared.toEnvelope().toXDR("base64"),
    fee: sim.minResourceFee,
  };
}

/**
 * Build an unsigned Stellar transaction that adds a USDC trustline (and, on a
 * network where mUSDC still predates the #578 SEP-41 cutover, an mUSDC one
 * too; mUSDC never needs a trustline post-cutover, see `MUSDC_ISSUER` in
 * constants.ts) for `walletAddress`. Skips any trustline that already
 * exists. Throws if all required trustlines are already present.
 */
export async function buildAddTrustlineTx(
  walletAddress: string,
  network: StellarNetwork
): Promise<{ xdr: string }> {
  const passphrase = passphraseFor(network);
  const horizon = horizonServer(network);
  const account = await horizon.loadAccount(walletAddress);
  const balances = account.balances;

  const ops: ReturnType<typeof Operation.changeTrust>[] = [];

  if (
    !hasAssetTrustline(balances, "USDC", USDC_ISSUER[network.network] ?? "")
  ) {
    ops.push(Operation.changeTrust({ asset: usdcAsset(network) }));
  }
  const musdcIssuer = MUSDC_ISSUER[network.network];
  if (musdcIssuer && !hasAssetTrustline(balances, "MUSDC", musdcIssuer)) {
    ops.push(Operation.changeTrust({ asset: musdcAsset(network) }));
  }

  if (ops.length === 0)
    throw new Error("All required trustlines already exist");

  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(300).build();

  return { xdr: tx.toEnvelope().toXDR("base64") };
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

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    const res = await withSorobanTimeout(() => server.getTransaction(hash));
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
