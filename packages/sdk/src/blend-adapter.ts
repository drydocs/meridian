import { Contract, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import {
  PoolV2,
  type Pool,
  type PoolUser,
  type Reserve,
} from "@blend-capital/blend-sdk";
import {
  prepareSorobanTx,
  simulateView,
  withBlendTimeout,
  type StellarNetwork,
} from "@meridian/stellar-sdk-helpers";
import {
  MalformedPoolResponseError,
  TimeoutError,
  UnsupportedError,
  ValidationError,
  classifyError,
} from "./errors.js";
import {
  redact,
  safeCall,
  sanitizeError,
  type InstrumentationHooks,
  type RequestEvent,
} from "./instrumentation.js";
import { withRetry, type RetryPolicy } from "./retry.js";
import { DEFAULT_RPC_TIMEOUT_MS } from "./vault-base.js";
import type { TimeoutOptions, Transaction } from "./types.js";

const BPS_SCALAR = 10_000;

// Blend adapter contract error `NotInitialized` (#3): `get_pool` panics with
// this before `initialize` has stored a pool for the adapter.
// Source: packages/contracts/blend-adapter/src/errors.rs.
const ADAPTER_NOT_INITIALIZED = /Error\(\s*Contract\s*,\s*#3\s*\)/i;

// StrKey-encoded contract address: "C" followed by 55 base32 characters.
const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

/** Configuration for a {@link BlendAdapterClient}. */
export interface BlendAdapterConfig {
  /** Bech32 contract address (C-address) of the Meridian Blend adapter. */
  adapterId: string;
  /** Stellar network context (network id, RPC URL, passphrase). */
  network: StellarNetwork;
  /** Timeout overrides. Defaults to a 12000ms RPC timeout. */
  timeouts?: TimeoutOptions;
  /** Opt-in retry policy. No retries when omitted. */
  retry?: RetryPolicy;
  /** Optional telemetry hooks; payloads are redacted before delivery. */
  hooks?: InstrumentationHooks;
}

/**
 * Injection seams for tests. Production callers never need these: the
 * defaults read the adapter and its pool from the configured network.
 */
export interface BlendAdapterDeps {
  /** Loads a Blend pool by its contract address. */
  loadPool?: (network: StellarNetwork, poolId: string) => Promise<Pool>;
  /** Simulates a read-only contract call and returns its decoded value. */
  simulate?: typeof simulateView;
  /** Assembles an unsigned Soroban transaction from an operation. */
  prepare?: typeof prepareSorobanTx;
}

/**
 * The protocol and pool a configured Blend adapter serves.
 *
 * Both values are read from the adapter contract (`get_protocol`, `get_pool`),
 * the same calls the accrual keeper's discovery path already makes.
 */
export interface BlendAdapterInfo {
  /** Bech32 contract address of the adapter these values came from. */
  adapterId: string;
  /** Protocol identifier reported by the adapter, normally "blend". */
  protocol: string;
  /** Bech32 contract address of the Blend pool the adapter supplies to. */
  poolId: string;
}

/**
 * Typed view of one Blend reserve, with rates already converted to
 * human-scale decimals (0.05 == 5%) and basis points.
 */
export interface BlendReserveInfo {
  /** Bech32 contract address of the pool this reserve belongs to. */
  poolId: string;
  /** Bech32 contract address of the reserve's asset (the SAC). */
  assetId: string;
  /** Reserve index in the pool. */
  index: number;
  /** Decimal places of the reserve's underlying asset. */
  decimals: number;
  /** Current APR paid to suppliers (0.05 == 5%). */
  supplyApr: number;
  /** Estimated supplier APY, weekly compounded (0.05 == 5%). */
  supplyApy: number;
  /** `supplyApy` in basis points, rounded. */
  supplyApyBps: number;
  /** Current APR charged to borrowers (0.05 == 5%). */
  borrowApr: number;
  /** Estimated borrower APY, daily compounded (0.05 == 5%). */
  borrowApy: number;
  /** Total supplied, in underlying asset stroops. */
  totalSupply: bigint;
  /** Total borrowed, in underlying asset stroops. */
  totalBorrows: bigint;
  /** Current utilization (0.8 == 80%). */
  utilization: number;
}

/**
 * One reserve's position for an account. Every amount is in underlying asset
 * stroops, matching the SDK's other position types.
 */
export interface BlendPosition {
  /** Bech32 contract address of the pool this position belongs to. */
  poolId: string;
  /** Bech32 contract address of the reserve's asset. */
  assetId: string;
  /** Reserve index in the pool. */
  index: number;
  /** Collateralized supply. */
  collateral: bigint;
  /** Non-collateralized supply. */
  supply: bigint;
  /** Outstanding borrows. */
  liabilities: bigint;
  /** `collateral + supply`. */
  total: bigint;
}

/**
 * Reads a configured Meridian Blend adapter and the pool it supplies to.
 *
 * The client is deliberately read-plus-build: it never signs or submits.
 * `buildAccrueTx` returns an unsigned XDR for the caller (a keeper or the
 * vault admin) to sign. Every on-chain call it makes is the same one the
 * rate source and the accrual keeper already use — `get_protocol` and
 * `get_pool` for discovery, `total_assets` for the cached valuation, and
 * `accrue` for the refresh — so the SDK does not invent a second dialect of
 * the adapter's interface.
 *
 * Pool responses are validated before they reach the caller. A pool id that
 * isn't a contract address, a missing reserve table, or a reserve without its
 * rate fields raises {@link MalformedPoolResponseError} rather than returning
 * partially typed data.
 */
export class BlendAdapterClient {
  protected readonly config: BlendAdapterConfig;
  private readonly deps: BlendAdapterDeps;
  private server: SorobanRpc.Server | undefined;

  constructor(config: BlendAdapterConfig, deps: BlendAdapterDeps = {}) {
    if (!CONTRACT_ADDRESS.test(config.adapterId ?? "")) {
      throw new ValidationError(
        "adapterId must be a Stellar contract address (C...)"
      );
    }
    for (const [name, value] of [
      ["timeouts.rpcMs", config.timeouts?.rpcMs],
      ["timeouts.operationMs", config.timeouts?.operationMs],
    ] as const) {
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
        throw new ValidationError(`${name} must be a positive number`);
      }
    }
    this.config = config;
    this.deps = deps;
  }

  /** Contract address of the adapter this client reads from. */
  get adapterId(): string {
    return this.config.adapterId;
  }

  /**
   * Resolves the pool and protocol for this configured adapter in one call.
   * Both reads are independent and run concurrently.
   */
  async discover(): Promise<BlendAdapterInfo> {
    return this.run("discover", {}, "read", async () => {
      const [protocol, poolId] = await Promise.all([
        this.readProtocol(),
        this.readPool(),
      ]);
      return { adapterId: this.config.adapterId, protocol, poolId };
    });
  }

  /** Protocol identifier reported by the adapter (normally "blend"). */
  async getProtocol(): Promise<string> {
    return this.run("getProtocol", {}, "read", () => this.readProtocol());
  }

  /**
   * Contract address of the Blend pool this adapter supplies to.
   *
   * Throws {@link UnsupportedError} when the adapter has not been initialized
   * with a pool, and {@link MalformedPoolResponseError} when `get_pool`
   * answers with something that is not a contract address.
   */
  async getPool(): Promise<string> {
    return this.run("getPool", {}, "read", () => this.readPool());
  }

  /**
   * The adapter's cached USDC valuation of its Blend position (stroops).
   *
   * Blend interest is only reflected as of the last `accrue()` call; call
   * {@link buildAccrueTx} (or the accrual keeper) first for a live value.
   */
  async getTotalAssets(): Promise<bigint> {
    return this.run("getTotalAssets", {}, "read", async () =>
      expectBigInt(await this.call("total_assets"), "total_assets")
    );
  }

  /**
   * Typed rates and totals for `assetId` in the adapter's pool.
   *
   * @param assetId Bech32 contract address of the reserve asset (USDC/EURC)
   */
  async getReserve(assetId: string): Promise<BlendReserveInfo> {
    if (!CONTRACT_ADDRESS.test(assetId ?? "")) {
      throw new ValidationError(
        "assetId must be a Stellar contract address (C...)"
      );
    }
    return this.run("getReserve", { assetId }, "read", () =>
      this.readReserve(assetId)
    );
  }

  /**
   * Current supply APY for `assetId` in basis points, rounded — the same
   * number the migration keeper's Blend rate source compares against
   * DeFindex.
   *
   * @param assetId Bech32 contract address of the reserve asset (USDC/EURC)
   */
  async getSupplyApy(assetId: string): Promise<number> {
    if (!CONTRACT_ADDRESS.test(assetId ?? "")) {
      throw new ValidationError(
        "assetId must be a Stellar contract address (C...)"
      );
    }
    return this.run("getSupplyApy", { assetId }, "read", async () => {
      const reserve = await this.findReserve(assetId);
      return toReserveInfo(this.adapterId, reserve).supplyApyBps;
    });
  }

  /**
   * The account's live position in every reserve of the adapter's pool.
   * Reserves the account does not touch are omitted; an account with no
   * position gets an empty array.
   *
   * @param account Stellar G-address to look up
   */
  async getPositions(account: string): Promise<BlendPosition[]> {
    if (typeof account !== "string" || account.length === 0) {
      throw new ValidationError("account is required");
    }
    return this.run("getPositions", { account }, "read", async () => {
      const pool = await this.loadPool();
      if (typeof pool.loadUser !== "function") {
        throw new MalformedPoolResponseError(
          `Blend pool ${pool.id} did not return a loadUser method`,
          { details: { poolId: pool.id } }
        );
      }
      const user = await withBlendTimeout(() => pool.loadUser(account));
      if (!isUserShape(user)) {
        throw new MalformedPoolResponseError(
          `Blend pool ${pool.id} returned a malformed user position`,
          { details: { poolId: pool.id, account } }
        );
      }
      return [...pool.reserves.entries()]
        .map(([assetId, reserve]) =>
          toPosition(pool.id, assetId, reserve, user)
        )
        .filter((position): position is BlendPosition => position !== null);
    });
  }

  /**
   * Build the unsigned `accrue()` transaction for this adapter. Anyone can
   * submit it; the SDK only assembles it.
   *
   * The adapter's protocol is re-read first so a client pointed at a
   * non-Blend adapter fails with a clear typed error rather than submitting
   * a call the contract does not export.
   *
   * @param caller Stellar G-address that will sign the transaction
   */
  async buildAccrueTx(caller: string): Promise<Transaction> {
    if (typeof caller !== "string" || caller.length === 0) {
      throw new ValidationError("caller is required");
    }
    return this.run("buildAccrueTx", { caller }, "build", async () => {
      const protocol = await this.readProtocol();
      if (protocol !== "blend") {
        throw new UnsupportedError(
          `adapter ${this.adapterId} reports protocol "${protocol}", not "blend"`,
          { details: { adapterId: this.adapterId, protocol } }
        );
      }
      const prepare = this.deps.prepare ?? prepareSorobanTx;
      return prepare(
        this.config.network,
        caller,
        new Contract(this.adapterId).call("accrue")
      );
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private rpcServer(): SorobanRpc.Server {
    this.server ??= new SorobanRpc.Server(this.config.network.rpcUrl, {
      timeout: this.config.timeouts?.rpcMs ?? DEFAULT_RPC_TIMEOUT_MS,
    });
    return this.server;
  }

  /** Simulate one adapter read; the seam tests inject through. */
  private call(method: string): Promise<unknown> {
    const simulate = this.deps.simulate ?? simulateView;
    return simulate(
      this.rpcServer(),
      this.adapterId,
      this.config.network.passphrase,
      method
    );
  }

  private async readProtocol(): Promise<string> {
    const raw = await this.call("get_protocol");
    if (typeof raw !== "string" || raw.length === 0) {
      throw new MalformedPoolResponseError(
        `get_protocol returned ${describe(raw)} instead of a protocol name`,
        { details: { adapterId: this.adapterId, method: "get_protocol" } }
      );
    }
    return raw;
  }

  private async readPool(): Promise<string> {
    let raw: unknown;
    try {
      raw = await this.call("get_pool");
    } catch (err) {
      if (err instanceof Error && ADAPTER_NOT_INITIALIZED.test(err.message)) {
        throw new UnsupportedError(
          `Blend adapter ${this.adapterId} has no pool configured; initialize it before reading the pool`,
          { cause: err, details: { adapterId: this.adapterId } }
        );
      }
      throw err;
    }
    if (typeof raw !== "string" || !CONTRACT_ADDRESS.test(raw)) {
      throw new MalformedPoolResponseError(
        `get_pool returned ${describe(raw)} instead of a contract address`,
        { details: { adapterId: this.adapterId, method: "get_pool" } }
      );
    }
    return raw;
  }

  /** Resolve the adapter's pool id and load the pool ledger state. */
  private async loadPool(): Promise<Pool> {
    const poolId = await this.readPool();
    const load =
      this.deps.loadPool ??
      ((network: StellarNetwork, id: string) =>
        withBlendTimeout(() =>
          PoolV2.load(
            { rpc: network.rpcUrl, passphrase: network.passphrase },
            id
          )
        ));
    const pool = await load(this.config.network, poolId);
    if (
      typeof pool !== "object" ||
      pool === null ||
      typeof pool.id !== "string" ||
      !(pool.reserves instanceof Map)
    ) {
      throw new MalformedPoolResponseError(
        `Blend pool ${poolId} returned an unexpected shape`,
        { details: { poolId } }
      );
    }
    return pool;
  }

  private async findReserve(assetId: string): Promise<Reserve> {
    const pool = await this.loadPool();
    const reserve = pool.reserves.get(assetId);
    if (!reserve) {
      throw new UnsupportedError(
        `Blend pool ${pool.id} has no reserve for ${assetId}`,
        { details: { poolId: pool.id, assetId } }
      );
    }
    return reserve;
  }

  private async readReserve(assetId: string): Promise<BlendReserveInfo> {
    return toReserveInfo(this.adapterId, await this.findReserve(assetId));
  }

  /**
   * Run one public SDK operation with typed errors, the optional per-call
   * time budget, the configured retry policy and instrumentation hooks.
   * Mirrors `VaultBase`'s runner so both clients behave identically.
   */
  private async run<T>(
    operation: string,
    params: Record<string, unknown>,
    kind: "read" | "build",
    fn: () => Promise<T>
  ): Promise<T> {
    const { hooks, retry, timeouts } = this.config;
    const safeParams = redact(params) as Record<string, unknown>;
    const base = (attempt: number): RequestEvent => ({
      operation,
      params: safeParams,
      attempt,
    });
    const policy =
      retry && (kind === "read" || retry.retryTxBuilders) ? retry : undefined;
    const operationMs = timeouts?.operationMs;

    const attemptFn = async (attempt: number): Promise<T> => {
      const started = Date.now();
      safeCall(hooks?.onRequestStart, base(attempt));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = fn();
        const result =
          operationMs === undefined
            ? await work
            : await Promise.race([
                work,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new TimeoutError(
                          `${operation} timed out after ${operationMs}ms`
                        )
                      ),
                    operationMs
                  );
                }),
              ]);
        safeCall(hooks?.onRequestSuccess, {
          ...base(attempt),
          durationMs: Date.now() - started,
        });
        return result;
      } catch (raw) {
        const error = classifyError(raw);
        safeCall(hooks?.onRequestError, {
          ...base(attempt),
          durationMs: Date.now() - started,
          error: sanitizeError(error),
        });
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    return withRetry(attemptFn, policy, {
      onRetry: ({ attempt, delayMs, error }) =>
        safeCall(hooks?.onRetry, {
          ...base(attempt),
          delayMs,
          error: sanitizeError(error),
        }),
    });
  }
}

// ---------------------------------------------------------------------------
// Pure shaping helpers
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function expectBigInt(value: unknown, method: string): bigint {
  if (typeof value === "bigint") return value;
  throw new MalformedPoolResponseError(
    `${method} returned ${describe(value)} instead of an integer amount`,
    { details: { method } }
  );
}

function toReserveInfo(adapterId: string, reserve: Reserve): BlendReserveInfo {
  const { assetId, config, data } = reserve;
  if (
    typeof assetId !== "string" ||
    !CONTRACT_ADDRESS.test(assetId) ||
    !config ||
    !isFiniteNumber(config.index) ||
    !isFiniteNumber(config.decimals) ||
    !isFiniteNumber(reserve.supplyApr) ||
    !isFiniteNumber(reserve.estSupplyApy) ||
    !isFiniteNumber(reserve.borrowApr) ||
    !isFiniteNumber(reserve.estBorrowApy) ||
    !data ||
    typeof reserve.toAssetFromBToken !== "function" ||
    typeof reserve.toAssetFromDToken !== "function"
  ) {
    throw new MalformedPoolResponseError(
      `Blend reserve ${describe(assetId)} in adapter ${adapterId} is missing its rate or supply fields`,
      { details: { adapterId, assetId: describe(assetId) } }
    );
  }
  return {
    poolId: reserve.poolId,
    assetId,
    index: config.index,
    decimals: config.decimals,
    supplyApr: reserve.supplyApr,
    supplyApy: reserve.estSupplyApy,
    supplyApyBps: Math.round(reserve.estSupplyApy * BPS_SCALAR),
    borrowApr: reserve.borrowApr,
    borrowApy: reserve.estBorrowApy,
    totalSupply: reserve.toAssetFromBToken(data.bSupply),
    totalBorrows: reserve.toAssetFromDToken(data.dSupply),
    utilization: reserve.getUtilizationFloat(),
  };
}

function isUserShape(user: PoolUser): user is PoolUser & {
  getCollateral(reserve: Reserve): bigint;
  getSupply(reserve: Reserve): bigint;
  getLiabilities(reserve: Reserve): bigint;
} {
  return (
    typeof user === "object" &&
    user !== null &&
    typeof user.getCollateral === "function" &&
    typeof user.getSupply === "function" &&
    typeof user.getLiabilities === "function"
  );
}

function toPosition(
  poolId: string,
  assetId: string,
  reserve: Reserve,
  user: PoolUser
): BlendPosition | null {
  const collateral = existingBigInt(
    user.getCollateral(reserve),
    "getCollateral"
  );
  const supply = existingBigInt(user.getSupply(reserve), "getSupply");
  const liabilities = existingBigInt(
    user.getLiabilities(reserve),
    "getLiabilities"
  );
  if (collateral <= 0n && supply <= 0n && liabilities <= 0n) return null;
  return {
    poolId,
    assetId,
    index: reserve.config.index,
    collateral,
    supply,
    liabilities,
    total: collateral + supply,
  };
}

function existingBigInt(value: unknown, method: string): bigint {
  if (typeof value === "bigint") return value;
  throw new MalformedPoolResponseError(
    `${method} returned ${describe(value)} instead of an integer amount`,
    { details: { method } }
  );
}
