import {
  Address,
  Contract,
  nativeToScVal,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { MAX_ADMIN_SLIPPAGE_BPS } from "@meridian/shared";
import { prepareSorobanTx, simulateView } from "@meridian/stellar-sdk-helpers";
import type {
  VaultConfig,
  Position,
  Transaction,
  AdapterInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers (private to this module)
// ---------------------------------------------------------------------------

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
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

/** Direction a share/asset conversion rounds in. */
export type Rounding = "down" | "up";

/**
 * Virtual share/asset offset that protects the first depositor against the
 * ERC-4626 inflation attack. The vault contract prices every deposit against
 * `total_assets + OFFSET` over `total_shares + OFFSET`
 * (`packages/contracts/vault/src/storage.rs`); mirroring the same value here
 * keeps the SDK's pure conversion math in sync with what the contract
 * actually mints.
 *
 * With an offset of 1_000 on both sides:
 *
 *   shares = assets * (totalSupply + 1_000) / (totalAssets + 1_000)
 *   assets = shares * (totalAssets + 1_000) / (totalSupply + 1_000)
 *
 * The virtual liquidity belongs to no one. An attacker who donates assets
 * directly to the adapter to inflate the share price recovers roughly
 * 1/1_000 of the donation, which makes the skim unprofitable, while an honest
 * first depositor against an empty vault still receives exactly `assets`
 * shares because the virtual denominator equals the virtual numerator. For
 * every other depositor the offset is negligible: 1_000 stroops is 0.0001
 * USDC.
 */
export const VIRTUAL_OFFSET = 1_000n;

/**
 * Convert an asset amount to shares using ERC-4626 virtual-offset math.
 * Defaults to rounding *down*, matching the contract's deposit direction: a
 * depositor is never credited more shares than their assets bought.
 *
 * Pass `"up"` when the share amount is being burned to release a requested
 * amount of assets. Rounding down there would release slightly less than the
 * requested USDC, so withdrawal sizing rounds up to the smallest share count
 * whose payout covers the request.
 *
 *   virtualSupply = totalSupply + VIRTUAL_OFFSET
 *   virtualAssets = totalAssets + VIRTUAL_OFFSET
 *   shares        = assets * virtualSupply / virtualAssets
 */
export function convertAssetsToShares(
  assets: bigint,
  totalAssets: bigint,
  totalSupply: bigint,
  rounding: Rounding = "down"
): bigint {
  const virtualAssets = totalAssets + VIRTUAL_OFFSET;
  const virtualSupply = totalSupply + VIRTUAL_OFFSET;
  const numerator = assets * virtualSupply;
  if (rounding === "up") {
    return (numerator + virtualAssets - 1n) / virtualAssets;
  }
  return numerator / virtualAssets;
}

/**
 * Convert a share amount to assets using ERC-4626 virtual-offset math.
 * Rounds *down* (floor division), matching the contract's withdrawal payout
 * and ERC-4626's `previewRedeem`.
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
 * which account signs the built transaction, then inherit:
 *
 *  - State-changing methods: `deposit`, `withdraw`, `setPaused`, `setAdapter`,
 *    `beginMigration`, `migrateAdapter`. Each returns `Promise<Transaction>`,
 *    an unsigned Soroban XDR that must be signed and submitted by the caller.
 *
 *  - Position queries: `getPosition`, `getPrincipal`.
 *
 *  - ERC-4626 view methods: `totalAssets`, `totalSupply`, `convertToShares`,
 *    `convertToAssets`, `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem`.
 *
 *  - Adapter and pause state: `isPaused`, `getAdapterInfo`.
 *
 * Every method builds the contract's own entry point with the same arguments,
 * so an on-chain rejection surfaces as a simulation error from
 * `prepareSorobanTx` rather than as a difference between the SDK's model and
 * the deployed contract.
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
   * Deposit `assets` USDC into the vault for the `receiver` account.
   *
   * Builds a `deposit(receiver, assets, 0)` contract call. The contract pulls
   * USDC from `receiver` and mints the shares to `receiver` in the same call,
   * so that address is the depositor and must be the one authorising the
   * transaction. The third argument is `min_shares_out`; passing 0 disables
   * slippage protection. Callers that need a minimum-shares guarantee should
   * call `convertToShares` first and construct the operation directly.
   *
   * @param assets   Amount in stroops (1 USDC = 10 000 000)
   * @param receiver Stellar G-address credited with mUSDC shares
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
   * corresponding shares from `owner`.
   *
   * MeridianVault has no separate payout address: `withdraw` authorises
   * `owner` and pays USDC to that same account, so `receiver` must equal
   * `owner` and a mismatch is rejected rather than silently ignored.
   *
   * The share amount is rounded up, so the payout covers `assets` rather than
   * falling a stroop short of it. Passing 0 as `min_usdc_out` disables the
   * contract's slippage floor; callers that want one should build the
   * operation directly with the value they are willing to accept.
   *
   * @param assets   USDC amount in stroops to redeem
   * @param receiver Stellar G-address to receive USDC (must equal owner)
   * @param owner    Stellar G-address whose mUSDC shares are burned
   */
  async withdraw(
    assets: bigint,
    receiver: string,
    owner: string
  ): Promise<Transaction> {
    if (assets <= 0n) throw new Error("assets must be positive");
    if (receiver !== owner) {
      throw new Error(
        "receiver must equal owner: MeridianVault pays USDC to the account that authorises the withdrawal"
      );
    }
    const [totalAssets, totalSupply] = await Promise.all([
      this.totalAssets(),
      this.totalSupply(),
    ]);
    const shares = convertAssetsToShares(
      assets,
      totalAssets,
      totalSupply,
      "up"
    );
    return this.prepare(
      this.contract().call("withdraw", addrScVal(owner), i128(shares), i128(0n))
    );
  }

  /**
   * Pause or resume the vault. Only callable by the vault admin.
   *
   * While paused the contract rejects new deposits. Withdrawals stay open, so
   * a pause can never trap funds already in the vault.
   *
   * @param paused `true` to pause deposits, `false` to resume them
   */
  async setPaused(paused: boolean): Promise<Transaction> {
    return this.prepare(
      this.contract().call(
        "set_paused",
        nativeToScVal(paused, { type: "bool" })
      )
    );
  }

  /**
   * Replace the vault's active adapter with `newAdapter` immediately,
   * without moving funds. To move the funds across as well, use
   * `beginMigration` followed by `migrateAdapter`.
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
   * Record a valuation snapshot of the current adapter and start the cooldown
   * that `migrateAdapter` requires. Only callable by the vault admin.
   *
   * The contract enforces a minimum ledger gap of 17 280 ledgers (roughly one
   * day) between this call and the migration, giving depositors a window to
   * exit before the vault's funds move to a new adapter.
   *
   * @param newAdapter Bech32 C-address of the adapter being migrated to
   */
  async beginMigration(newAdapter: string): Promise<Transaction> {
    return this.prepare(
      this.contract().call("begin_migration", addrScVal(newAdapter))
    );
  }

  /**
   * Move the vault's funds from the active adapter to `newAdapter`.
   * Only callable by the vault admin, and only after `beginMigration` has
   * recorded a snapshot for the same `newAdapter` and the cooldown has
   * elapsed. Calling it earlier fails with `MigrationNotInitialized` or
   * `MigrationCooldownNotMet`.
   *
   * @param newAdapter     Bech32 C-address of the target adapter
   * @param maxSlippageBps Maximum tolerated value loss in basis points,
   *                       capped by the contract at 500
   */
  async migrateAdapter(
    newAdapter: string,
    maxSlippageBps: number
  ): Promise<Transaction> {
    if (maxSlippageBps < 0 || maxSlippageBps > MAX_ADMIN_SLIPPAGE_BPS) {
      throw new Error(
        `maxSlippageBps must be between 0 and ${MAX_ADMIN_SLIPPAGE_BPS}`
      );
    }
    return this.prepare(
      this.contract().call(
        "migrate_adapter",
        addrScVal(newAdapter),
        u32(maxSlippageBps)
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
      await simulateView(
        server,
        contractId,
        passphrase,
        "get_position",
        callerScVal
      )
    );
    if (sharesRaw <= 0n) return null;

    const [totalAssetsRaw, totalSharesRaw, principalRaw, entryTimeRaw] =
      await Promise.all([
        simulateView(server, contractId, passphrase, "get_total_assets"),
        simulateView(server, contractId, passphrase, "get_total_shares"),
        simulateView(
          server,
          contractId,
          passphrase,
          "get_principal",
          callerScVal
        ),
        simulateView(
          server,
          contractId,
          passphrase,
          "get_entry_time",
          callerScVal
        ),
      ]);

    const totalAssets = bigIntFrom(totalAssetsRaw);
    const totalShares = bigIntFrom(totalSharesRaw);
    const principal = bigIntFrom(principalRaw);
    const entryTime = bigIntFrom(entryTimeRaw);

    const deposited = convertSharesToAssets(
      sharesRaw,
      totalAssets,
      totalShares
    );

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
   * Convert an asset amount to the equivalent shares at the current exchange
   * rate, including ERC-4626 virtual-offset inflation protection.
   * ERC-4626 `convertToShares(uint256 assets)`, so it rounds down.
   *
   * @param assets Amount in stroops to convert
   */
  async convertToShares(assets: bigint): Promise<bigint> {
    const [ta, ts] = await Promise.all([
      this.totalAssets(),
      this.totalSupply(),
    ]);
    return convertAssetsToShares(assets, ta, ts);
  }

  /**
   * Convert a share amount to the equivalent assets at the current exchange
   * rate, including ERC-4626 virtual-offset inflation protection.
   * ERC-4626 `convertToAssets(uint256 shares)`.
   *
   * @param shares Share amount in stroops to convert
   */
  async convertToAssets(shares: bigint): Promise<bigint> {
    const [ta, ts] = await Promise.all([
      this.totalAssets(),
      this.totalSupply(),
    ]);
    return convertSharesToAssets(shares, ta, ts);
  }

  /**
   * Maximum USDC that `receiver` may deposit in a single transaction.
   * Returns a large sentinel while deposits are open, 0n once the vault is
   * paused. ERC-4626 `maxDeposit(address)`.
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
   * Maximum USDC that `owner` may withdraw in a single transaction: the full
   * redemption value of their position. A pause does not restrict this, since
   * the contract leaves withdrawals open while paused.
   * ERC-4626 `maxWithdraw(address)`.
   *
   * @param owner Stellar G-address to check
   */
  async maxWithdraw(owner: string): Promise<bigint> {
    const pos = await this.getPosition(owner);
    return pos?.deposited ?? 0n;
  }

  /**
   * Maximum shares that `owner` may redeem in a single transaction: their full
   * share balance. A pause does not restrict this, since the contract leaves
   * withdrawals open while paused.
   * ERC-4626 `maxRedeem(address)`.
   *
   * @param owner Stellar G-address to check
   */
  async maxRedeem(owner: string): Promise<bigint> {
    const pos = await this.getPosition(owner);
    return pos?.shares ?? 0n;
  }

  // -------------------------------------------------------------------------
  // Adapter and pause state
  // -------------------------------------------------------------------------

  /**
   * Returns `true` while the vault is paused. A paused vault rejects deposits
   * and leaves withdrawals open.
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
