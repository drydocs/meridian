import { Address, Contract, nativeToScVal, rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";
import {
  prepareSorobanTx,
  simulateView,
} from "@meridian/stellar-sdk-helpers";
import type { VaultConfig, Position, Transaction, AdapterInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers (private to this module)
// ---------------------------------------------------------------------------

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

function u64(value: number): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "u64" });
}

function u32(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

function addrScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

function bigIntFrom(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (value === null || value === undefined) return 0n;
  throw new TypeError(
    `bigIntFrom: unexpected type ${typeof value}: ${String(value)}`
  );
}

// ---------------------------------------------------------------------------
// ERC-4626 inflation-attack protection
// ---------------------------------------------------------------------------

/**
 * Virtual share/asset offset that protects the first depositor against the
 * ERC-4626 inflation attack.  The vault contract enforces this same offset
 * on-chain; mirroring it here keeps the SDK's pure conversion math in sync
 * and makes it directly testable.
 *
 * With an offset of 1 on both sides:
 *
 *   shares = assets * (totalSupply + 1) / (totalAssets + 1)
 *   assets = shares * (totalAssets + 1) / (totalSupply + 1)
 *
 * A first depositor minting against an empty vault (totalSupply=0,
 * totalAssets=0) always gets exactly `assets` shares because the virtual
 * denominator equals the virtual numerator.  An attacker who inflates the
 * exchange rate by donating directly to the vault cannot skew the first
 * legitimate depositor's share count to zero, because both sides of the
 * ratio shift together.
 */
export const VIRTUAL_OFFSET = 1n;

/**
 * Convert an asset amount to shares using ERC-4626 virtual-offset math.
 * Rounds *down* (floor division), matching the deposit direction in the
 * on-chain contract.
 *
 *   virtualSupply = totalSupply + VIRTUAL_OFFSET
 *   virtualAssets = totalAssets + VIRTUAL_OFFSET
 *   shares        = assets * virtualSupply / virtualAssets
 */
export function convertAssetsToShares(
  assets: bigint,
  totalAssets: bigint,
  totalSupply: bigint
): bigint {
  const virtualAssets = totalAssets + VIRTUAL_OFFSET;
  const virtualSupply = totalSupply + VIRTUAL_OFFSET;
  return (assets * virtualSupply) / virtualAssets;
}

/**
 * Convert a share amount to assets using ERC-4626 virtual-offset math.
 * Rounds *down* (floor division), matching the withdraw direction in the
 * on-chain contract.
 *
 *   assets = shares * virtualAssets / virtualSupply
 */
export function convertSharesToAssets(
  shares: bigint,
  totalAssets: bigint,
  totalSupply: bigint
): bigint {
  const virtualAssets = totalAssets + VIRTUAL_OFFSET;
  const virtualSupply = totalSupply + VIRTUAL_OFFSET;
  return (shares * virtualAssets) / virtualSupply;
}

// ---------------------------------------------------------------------------
// VaultBase abstract class
// ---------------------------------------------------------------------------

/**
 * Abstract base class for MeridianVault coordinator contracts.
 *
 * Subclasses supply the `caller` property (a Stellar G-address) to identify
 * which account builds the transactions, then inherit:
 *
 *  - State-changing methods: `deposit`, `withdraw`, `pause`, `unpause`,
 *    `setAdapter`, `migrateAdapter` — each returns `Promise<Transaction>`,
 *    an unsigned Soroban XDR that must be signed and submitted by the caller.
 *
 *  - Position queries: `getPosition`, `getPrincipal`.
 *
 *  - ERC-4626 view methods: `totalAssets`, `totalSupply`, `convertToShares`,
 *    `convertToAssets`, `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem`.
 *
 *  - Adapter/pause state: `isPaused`, `getAdapterInfo`.
 *
 * All asset/share values are in stroops (1 USDC = 10 000 000 stroops).
 *
 * The `makeRpcServer` method is overridable to support dependency injection
 * in tests without mocking the `rpc.Server` constructor directly.
 */
export abstract class VaultBase {
  protected readonly config: VaultConfig;

  constructor(config: VaultConfig) {
    this.config = config;
  }

  /**
   * The Stellar public key (G-address) that will sign the resulting XDR.
   * Subclasses must implement this property.
   */
  protected abstract get caller(): string;

  /**
   * Factory for the Soroban RPC server instance. Overridable in tests to
   * avoid constructing a real network client.
   */
  protected makeRpcServer(): SorobanRpc.Server {
    return new SorobanRpc.Server(this.config.network.rpcUrl, {
      timeout: 12_000,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private get contractId(): string {
    return this.config.contractId;
  }

  private contract(): Contract {
    return new Contract(this.contractId);
  }

  private async view(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const { network } = this.config;
    return simulateView(
      this.makeRpcServer(),
      this.contractId,
      network.passphrase,
      method,
      ...args
    );
  }

  private async prepare(op: xdr.Operation): Promise<Transaction> {
    return prepareSorobanTx(this.config.network, this.caller, op);
  }

  // -------------------------------------------------------------------------
  // State-changing operations
  // -------------------------------------------------------------------------

  /**
   * Deposit `assets` USDC into the vault on behalf of `receiver`.
   *
   * Builds a `deposit(receiver, assets, 0)` contract call. The third
   * argument is `min_shares_out`; passing 0 disables slippage protection.
   * Callers that need a minimum-shares guarantee should call
   * `convertToShares` first and construct the operation directly.
   *
   * @param assets   Amount in stroops (1 USDC = 10 000 000)
   * @param receiver Stellar G-address to credit with mUSDC shares
   */
  async deposit(assets: bigint, receiver: string): Promise<Transaction> {
    if (assets <= 0n) throw new Error("assets must be positive");
    return this.prepare(
      this.contract().call(
        "deposit",
        addrScVal(receiver),
        i128(assets),
        i128(0n)
      )
    );
  }

  /**
   * Withdraw USDC equivalent to `assets` from the vault, burning the
   * corresponding shares from `owner` and sending USDC to `owner`.
   *
   * The MeridianVault coordinator uses a single address as both the share
   * source and the USDC destination. Converts `assets` to shares via
   * `convertToShares` (using current vault state), then builds a
   * `withdraw(owner, shares, 0)` call. Passing 0 as `min_usdc_out` disables
   * slippage protection.
   *
   * @param assets   USDC amount in stroops to redeem
   * @param receiver Stellar G-address to receive USDC (must equal owner on MeridianVault)
   * @param owner    Stellar G-address whose mUSDC shares are burned
   */
  async withdraw(
    assets: bigint,
    _receiver: string,
    owner: string
  ): Promise<Transaction> {
    if (assets <= 0n) throw new Error("assets must be positive");
    const shares = await this.convertToShares(assets);
    return this.prepare(
      this.contract().call(
        "withdraw",
        addrScVal(owner),
        i128(shares),
        i128(0n)
      )
    );
  }

  /**
   * Pause the vault, blocking all deposits and withdrawals.
   * Only callable by the vault admin.
   */
  async pause(): Promise<Transaction> {
    return this.prepare(this.contract().call("pause"));
  }

  /**
   * Unpause the vault, re-enabling deposits and withdrawals.
   * Only callable by the vault admin.
   */
  async unpause(): Promise<Transaction> {
    return this.prepare(this.contract().call("unpause"));
  }

  /**
   * Replace the vault's active adapter with `newAdapter` immediately,
   * without moving funds.  To atomically transfer funds, use
   * `migrateAdapter` instead.
   * Only callable by the vault admin.
   *
   * @param newAdapter Bech32 C-address of the replacement adapter contract
   */
  async setAdapter(newAdapter: string): Promise<Transaction> {
    return this.prepare(
      this.contract().call("set_adapter", addrScVal(newAdapter))
    );
  }

  /**
   * Begin or complete an atomic adapter migration.
   *
   * The on-chain `migrate_adapter` entry-point is gated by a ~1-day
   * timelock and a slippage bound.  Call this once to initiate; call it
   * again after the timelock has elapsed to execute the fund transfer.
   *
   * @param newAdapter  Bech32 C-address of the target adapter
   * @param deadline    Unix timestamp (seconds) by which migration must finish
   * @param slippageBps Maximum tolerated value loss in basis points (0–10000)
   */
  async migrateAdapter(
    newAdapter: string,
    deadline: number,
    slippageBps: number
  ): Promise<Transaction> {
    if (deadline <= 0) throw new Error("deadline must be a positive timestamp");
    if (slippageBps < 0 || slippageBps > 10_000)
      throw new Error("slippageBps must be between 0 and 10000");
    return this.prepare(
      this.contract().call(
        "migrate_adapter",
        addrScVal(newAdapter),
        u64(deadline),
        u32(slippageBps)
      )
    );
  }

  // -------------------------------------------------------------------------
  // Position queries
  // -------------------------------------------------------------------------

  /**
   * Fetch the current position for `account`.
   *
   * Issues five parallel on-chain view calls (`get_position`,
   * `get_total_assets`, `get_total_shares`, `get_principal`,
   * `get_entry_time`) and derives the display-ready position.
   * Returns `null` when the account holds no shares.
   *
   * @param account Stellar G-address to look up
   */
  async getPosition(account: string): Promise<Position | null> {
    const callerScVal = addrScVal(account);
    const server = this.makeRpcServer();
    const { passphrase } = this.config.network;
    const contractId = this.contractId;

    const sharesRaw = bigIntFrom(
      await simulateView(server, contractId, passphrase, "get_position", callerScVal)
    );
    if (sharesRaw <= 0n) return null;

    const [totalAssetsRaw, totalSharesRaw, principalRaw, entryTimeRaw] =
      await Promise.all([
        simulateView(server, contractId, passphrase, "get_total_assets"),
        simulateView(server, contractId, passphrase, "get_total_shares"),
        simulateView(server, contractId, passphrase, "get_principal", callerScVal),
        simulateView(server, contractId, passphrase, "get_entry_time", callerScVal),
      ]);

    const totalAssets = bigIntFrom(totalAssetsRaw);
    const totalShares = bigIntFrom(totalSharesRaw);
    const principal = bigIntFrom(principalRaw);
    const entryTime = bigIntFrom(entryTimeRaw);

    const deposited =
      totalShares > 0n ? (sharesRaw * totalAssets) / totalShares : 0n;

    const hasBasis = principal > 0n;
    const earned =
      hasBasis && deposited > principal ? deposited - principal : 0n;

    return {
      vaultId: contractId,
      shares: sharesRaw,
      deposited,
      earned,
      entryTime: Number(entryTime),
      principal,
    };
  }

  /**
   * Fetch the USDC cost basis recorded on-chain for `account` (stroops).
   * Returns 0n when no principal is stored (e.g. position arrived via an
   * mUSDC transfer rather than a direct deposit).
   *
   * @param account Stellar G-address to look up
   */
  async getPrincipal(account: string): Promise<bigint> {
    return bigIntFrom(await this.view("get_principal", addrScVal(account)));
  }

  // -------------------------------------------------------------------------
  // ERC-4626 view methods
  // -------------------------------------------------------------------------

  /**
   * Total USDC assets managed by the vault and its active adapter (stroops).
   * ERC-4626 `totalAssets()`.
   */
  async totalAssets(): Promise<bigint> {
    return bigIntFrom(await this.view("get_total_assets"));
  }

  /**
   * Total mUSDC shares currently in circulation (stroops).
   * ERC-4626 `totalSupply()`.
   */
  async totalSupply(): Promise<bigint> {
    return bigIntFrom(await this.view("get_total_shares"));
  }

  /**
   * Convert an asset amount to the equivalent shares at the current
   * exchange rate, including ERC-4626 virtual-offset inflation protection.
   * ERC-4626 `convertToShares(uint256 assets)`.
   *
   * @param assets Amount in stroops to convert
   */
  async convertToShares(assets: bigint): Promise<bigint> {
    const [ta, ts] = await Promise.all([this.totalAssets(), this.totalSupply()]);
    return convertAssetsToShares(assets, ta, ts);
  }

  /**
   * Convert a share amount to the equivalent assets at the current
   * exchange rate, including ERC-4626 virtual-offset inflation protection.
   * ERC-4626 `convertToAssets(uint256 shares)`.
   *
   * @param shares Share amount in stroops to convert
   */
  async convertToAssets(shares: bigint): Promise<bigint> {
    const [ta, ts] = await Promise.all([this.totalAssets(), this.totalSupply()]);
    return convertSharesToAssets(shares, ta, ts);
  }

  /**
   * Maximum USDC that `receiver` may deposit in a single transaction.
   * Returns a large sentinel when unpaused, 0n when paused.
   * ERC-4626 `maxDeposit(address)`.
   */
  async maxDeposit(_receiver: string): Promise<bigint> {
    return (await this.isPaused()) ? 0n : BigInt("999999999999999999999999999");
  }

  /**
   * Maximum shares that `receiver` may mint in a single transaction.
   * Returns the share equivalent of `maxDeposit` at the current rate.
   * ERC-4626 `maxMint(address)`.
   */
  async maxMint(_receiver: string): Promise<bigint> {
    const maxDep = await this.maxDeposit(_receiver);
    if (maxDep === 0n) return 0n;
    return this.convertToShares(maxDep);
  }

  /**
   * Maximum USDC that `owner` may withdraw in a single transaction.
   * Returns the full redemption value of their position, or 0n when paused.
   * ERC-4626 `maxWithdraw(address)`.
   *
   * @param owner Stellar G-address to check
   */
  async maxWithdraw(owner: string): Promise<bigint> {
    if (await this.isPaused()) return 0n;
    const pos = await this.getPosition(owner);
    return pos?.deposited ?? 0n;
  }

  /**
   * Maximum shares that `owner` may redeem in a single transaction.
   * Returns their full share balance, or 0n when paused.
   * ERC-4626 `maxRedeem(address)`.
   *
   * @param owner Stellar G-address to check
   */
  async maxRedeem(owner: string): Promise<bigint> {
    if (await this.isPaused()) return 0n;
    const pos = await this.getPosition(owner);
    return pos?.shares ?? 0n;
  }

  // -------------------------------------------------------------------------
  // Adapter and pause state
  // -------------------------------------------------------------------------

  /**
   * Returns `true` when the vault is paused (deposits and withdrawals
   * are blocked).
   */
  async isPaused(): Promise<boolean> {
    return Boolean(await this.view("is_paused"));
  }

  /**
   * Returns on-chain information about the vault's active adapter.
   */
  async getAdapterInfo(): Promise<AdapterInfo> {
    const server = this.makeRpcServer();
    const { passphrase } = this.config.network;
    const contractId = this.contractId;

    const adapterId = (await simulateView(
      server,
      contractId,
      passphrase,
      "get_adapter"
    )) as string;

    const [protocol, totalAssetsRaw] = await Promise.all([
      simulateView(server, adapterId, passphrase, "get_protocol"),
      simulateView(server, contractId, passphrase, "get_total_assets"),
    ]);

    return {
      adapterId,
      protocol: protocol as string,
      totalAssets: bigIntFrom(totalAssetsRaw),
    };
  }
}
