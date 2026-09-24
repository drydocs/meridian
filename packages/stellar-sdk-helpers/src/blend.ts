import { xdr } from "@stellar/stellar-sdk";
import { PoolContractV2, PoolV2, RequestType } from "@blend-capital/blend-sdk";
import { withRetry, withRaceTimeout } from "@meridian/shared";
import { prepareSorobanTx } from "./tx";
import type { StellarNetwork } from "./types";
import type { PositionInfo } from "./positions";

export const BLEND_RPC_TIMEOUT_MS = 10_000;

// The Blend SDK does not accept an AbortSignal, so we race the call against a
// manual timeout rejection. The underlying fetch will still complete, but the
// caller gets a fast failure it can retry rather than waiting for Vercel's
// function-level deadline. Exported so other Blend-SDK call sites (see
// rate-sources.ts) share this instead of redefining it, and stay in sync if
// the timeout is ever tuned.
export const withBlendTimeout = <T>(
  fn: () => Promise<T>,
  ms = BLEND_RPC_TIMEOUT_MS
) => withRaceTimeout(fn, ms, "Blend RPC");

export interface BlendPoolConfig {
  // Blend pool contract (C...) the request is submitted to.
  poolId: string;
  // Reserve asset contract — the USDC/EURC Stellar Asset Contract being moved.
  assetId: string;
  network: StellarNetwork;
}

/**
 * Map a Meridian vault ID (e.g. "blend-usdc-fixed") to the reserve asset whose
 * Stellar Asset Contract the deposit supplies. Pure function, no I/O.
 */
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
  return prepareSorobanTx(config.network, caller, op);
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
  return buildPoolRequestTx(
    config,
    depositor,
    RequestType.SupplyCollateral,
    amount
  );
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
  return buildPoolRequestTx(
    config,
    withdrawer,
    RequestType.WithdrawCollateral,
    amount
  );
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
 * via the SDK in underlying asset units.
 *
 * `shares` is the collateral-only balance because Meridian withdrawals use
 * RequestType.WithdrawCollateral; including plain-supply in `shares` would cause
 * the withdraw-max flow to submit an amount the pool contract would reject.
 * `deposited` is the full balance (collateral + plain supply) for display.
 * `earned` is 0 -- a direct Blend supply has no on-chain cost basis.
 */
export async function fetchBlendPositions(
  network: StellarNetwork,
  poolId: string,
  publicKey: string,
  reserves: BlendReserveRef[]
): Promise<PositionInfo[]> {
  const pool = await withRetry(() =>
    withBlendTimeout(() =>
      PoolV2.load(
        { rpc: network.rpcUrl, passphrase: network.passphrase },
        poolId
      )
    )
  );
  const user = await withRetry(() =>
    withBlendTimeout(() => pool.loadUser(publicKey))
  );

  const positions: PositionInfo[] = [];
  for (const { assetId, vaultId } of reserves) {
    const reserve = pool.reserves.get(assetId);
    if (!reserve) continue;
    const collateral = user.getCollateralFloat(reserve);
    const total = collateral + user.getSupplyFloat(reserve);
    if (total <= 0) continue;
    positions.push({
      vaultId,
      shares: collateral,
      deposited: total,
      earned: 0,
      entryTime: 0,
    });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Blend adapter client (@meridian SDK surface for issue #805)
// ---------------------------------------------------------------------------

export interface BlendTx {
  /** Base64 transaction XDR ready for wallet signing. */
  xdr: string;
  fee: string;
}

export interface BlendPoolInfo {
  poolId: string;
  backstopRate: number;
  reserveCount: number;
  reserves: string[];
}

export interface BlendUserPosition {
  account: string;
  poolId: string;
  collateral: Record<string, number>;
  liabilities: Record<string, number>;
  supply: Record<string, number>;
}

export interface BlendAdapterConfig extends BlendPoolConfig {}

/**
 * High-level Blend Capital adapter used by Meridian callers.
 * Builds unsigned Soroban transactions for supply / borrow / repay / withdraw
 * and reads pool + health data over RPC.
 */
export class BlendAdapterClient {
  constructor(private readonly config: BlendAdapterConfig) {}

  /** Supply (as collateral) `amount` of the configured reserve asset. */
  supply(asset: string, amount: bigint, account: string): Promise<BlendTx> {
    return buildPoolRequestTx(
      { ...this.config, assetId: asset || this.config.assetId },
      account,
      RequestType.SupplyCollateral,
      amount
    );
  }

  /**
   * Borrow `amount` of `asset` against the caller's collateral position.
   * `collateral` is accepted for API completeness; Blend V2 borrow uses the
   * pool's existing collateral balances for `account`.
   */
  borrow(
    asset: string,
    amount: bigint,
    account: string,
    _collateral: string
  ): Promise<BlendTx> {
    return buildPoolRequestTx(
      { ...this.config, assetId: asset || this.config.assetId },
      account,
      RequestType.Borrow,
      amount
    );
  }

  /** Repay `amount` of borrowed `asset`. */
  repay(asset: string, amount: bigint, account: string): Promise<BlendTx> {
    return buildPoolRequestTx(
      { ...this.config, assetId: asset || this.config.assetId },
      account,
      RequestType.Repay,
      amount
    );
  }

  /** Withdraw supplied collateral of `asset`. */
  withdraw(asset: string, amount: bigint, account: string): Promise<BlendTx> {
    return buildPoolRequestTx(
      { ...this.config, assetId: asset || this.config.assetId },
      account,
      RequestType.WithdrawCollateral,
      amount
    );
  }

  /**
   * Approximate Blend health factor as collateral / borrowed (float units).
   * Returns `Number.POSITIVE_INFINITY` when there is no borrow.
   */
  async getHealthFactor(
    account: string,
    collateralAsset: string,
    borrowedAsset: string
  ): Promise<number> {
    const pool = await withRetry(() =>
      withBlendTimeout(() =>
        PoolV2.load(
          { rpc: this.config.network.rpcUrl, passphrase: this.config.network.passphrase },
          this.config.poolId
        )
      )
    );
    const user = await withRetry(() => withBlendTimeout(() => pool.loadUser(account)));
    const collRes = pool.reserves.get(collateralAsset);
    const borrowRes = pool.reserves.get(borrowedAsset);
    const collateral = collRes ? user.getCollateralFloat(collRes) : 0;
    const borrowed = borrowRes ? user.getLiabilitiesFloat(borrowRes) : 0;
    if (borrowed <= 0) return Number.POSITIVE_INFINITY;
    return collateral / borrowed;
  }

  async getPoolInfo(poolId: string = this.config.poolId): Promise<BlendPoolInfo> {
    const pool = await withRetry(() =>
      withBlendTimeout(() =>
        PoolV2.load(
          { rpc: this.config.network.rpcUrl, passphrase: this.config.network.passphrase },
          poolId
        )
      )
    );
    const reserves = [...pool.reserves.keys()];
    return {
      poolId,
      backstopRate: Number((pool as { config?: { backstopRate?: number } }).config?.backstopRate ?? 0),
      reserveCount: reserves.length,
      reserves,
    };
  }

  async getUserPosition(
    account: string,
    poolId: string = this.config.poolId
  ): Promise<BlendUserPosition> {
    const pool = await withRetry(() =>
      withBlendTimeout(() =>
        PoolV2.load(
          { rpc: this.config.network.rpcUrl, passphrase: this.config.network.passphrase },
          poolId
        )
      )
    );
    const user = await withRetry(() => withBlendTimeout(() => pool.loadUser(account)));
    const collateral: Record<string, number> = {};
    const liabilities: Record<string, number> = {};
    const supply: Record<string, number> = {};
    for (const [assetId, reserve] of pool.reserves.entries()) {
      const c = user.getCollateralFloat(reserve);
      const l = user.getLiabilitiesFloat(reserve);
      const s = user.getSupplyFloat(reserve);
      if (c > 0) collateral[assetId] = c;
      if (l > 0) liabilities[assetId] = l;
      if (s > 0) supply[assetId] = s;
    }
    return { account, poolId, collateral, liabilities, supply };
  }
}

