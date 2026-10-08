import {
  FixedPointDecimal,
  STROOPS_PER_UNIT,
  UnknownAssetError,
} from "./types";
import type { AssetSymbol } from "./types";

export type PriceSet = ReadonlyMap<AssetSymbol, FixedPointDecimal>;

export class InvalidFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFillError";
  }
}

export class AccountingIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingIdentityError";
  }
}

/**
 * A signed trade against one asset. Positive `size` buys, negative sells.
 * `size` and `price` are fixed-point decimals (7 places), `fee` is a
 * non-negative cost in the quote currency charged on top of the trade.
 */
export interface Fill {
  asset: AssetSymbol;
  size: FixedPointDecimal;
  price: FixedPointDecimal;
  fee?: FixedPointDecimal | undefined;
}

export interface Position {
  asset: AssetSymbol;
  /** Signed size: positive long, negative short. Never zero when held. */
  size: FixedPointDecimal;
  /** Signed cost basis: sum of signed fill notionals still open. */
  basis: FixedPointDecimal;
}

/** size * price in quote units, truncated toward zero to 7 places. */
function notional(size: bigint, price: bigint): bigint {
  return (size * price) / STROOPS_PER_UNIT;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

interface InternalPosition {
  size: bigint;
  basis: bigint;
}

/**
 * Portfolio accounting for a simulated run.
 *
 * All arithmetic is bigint stroops (FixedPointDecimal), never floats.
 * Multiplications truncate toward zero; the same rule is used everywhere so
 * the accounting identity is exact, not approximate:
 *
 *   cash + positionValue(prices)
 *     == initialCash + realized + unrealized(prices) - fees
 *
 * Flipping a position through zero in one fill is rejected; close it and
 * open the other side with two fills. Cash may go negative (margin or
 * borrowed funding); callers that need a limit enforce it themselves.
 */
export class Portfolio {
  readonly initialCash: FixedPointDecimal;
  #cash: bigint;
  #realized = 0n;
  #fees = 0n;
  readonly #positions = new Map<AssetSymbol, InternalPosition>();

  constructor(initialCash: FixedPointDecimal) {
    this.initialCash = initialCash;
    this.#cash = initialCash.toStroops();
  }

  get cash(): FixedPointDecimal {
    return FixedPointDecimal.fromStroops(this.#cash);
  }

  /**
   * Realized result from reductions and closes, plus any cash flowed in
   * through {@link applyCashFlow}, before fees.
   */
  get realized(): FixedPointDecimal {
    return FixedPointDecimal.fromStroops(this.#realized);
  }

  /** Cumulative fees paid. */
  get fees(): FixedPointDecimal {
    return FixedPointDecimal.fromStroops(this.#fees);
  }

  getPosition(asset: AssetSymbol): Position | undefined {
    const p = this.#positions.get(asset);
    if (!p) return undefined;
    return {
      asset,
      size: FixedPointDecimal.fromStroops(p.size),
      basis: FixedPointDecimal.fromStroops(p.basis),
    };
  }

  positions(): Position[] {
    return [...this.#positions.keys()]
      .sort()
      .map((asset) => this.getPosition(asset) as Position);
  }

  /** Apply a fill: open, increase, reduce or close a position. */
  applyFill(fill: Fill): void {
    const delta = fill.size.toStroops();
    const price = fill.price.toStroops();
    const fee = fill.fee?.toStroops() ?? 0n;
    if (delta === 0n) throw new InvalidFillError("fill size must be non-zero");
    if (price < 0n) throw new InvalidFillError("fill price must be >= 0");
    if (fee < 0n) throw new InvalidFillError("fill fee must be >= 0");

    const value = notional(delta, price);
    const current = this.#positions.get(fill.asset);

    if (!current || current.size === 0n) {
      this.#positions.set(fill.asset, { size: delta, basis: value });
    } else if (current.size > 0n === delta > 0n) {
      current.size += delta;
      current.basis += value;
    } else {
      const reduceBy = abs(delta);
      const held = abs(current.size);
      if (reduceBy > held) {
        throw new InvalidFillError(
          `fill of ${fill.size.toString()} ${fill.asset} would flip the position through zero`
        );
      }
      const released =
        reduceBy === held ? current.basis : (current.basis * reduceBy) / held;
      // Cash received (or paid, when covering a short) by this fill.
      this.#realized += -value - released;
      current.size += delta;
      current.basis -= released;
      if (current.size === 0n) this.#positions.delete(fill.asset);
    }

    this.#cash -= value + fee;
    this.#fees += fee;
  }

  /**
   * Credit (positive) or debit (negative) a cash flow that is not a fill, such
   * as the funding and interest the accrual engine returns (#877).
   *
   * It is recorded as realized, which is the only term of the accounting
   * identity a cash flow can move: `totalValue` and the conserved side both
   * shift by the same amount, so the identity keeps holding.
   */
  applyCashFlow(amount: FixedPointDecimal): void {
    const stroops = amount.toStroops();
    this.#cash += stroops;
    this.#realized += stroops;
  }

  #markValue(asset: AssetSymbol, size: bigint, prices: PriceSet): bigint {
    const price = prices.get(asset);
    if (!price) throw new UnknownAssetError(asset);
    return notional(size, price.toStroops());
  }

  /** Sum of size * price over open positions. */
  positionValue(prices: PriceSet): FixedPointDecimal {
    let total = 0n;
    for (const [asset, p] of this.#positions) {
      total += this.#markValue(asset, p.size, prices);
    }
    return FixedPointDecimal.fromStroops(total);
  }

  /** Mark-to-market result on open positions: value minus basis. */
  unrealized(prices: PriceSet): FixedPointDecimal {
    let total = 0n;
    for (const [asset, p] of this.#positions) {
      total += this.#markValue(asset, p.size, prices) - p.basis;
    }
    return FixedPointDecimal.fromStroops(total);
  }

  /** Cash plus position value at the given prices (net of fees already paid). */
  totalValue(prices: PriceSet): FixedPointDecimal {
    return FixedPointDecimal.fromStroops(
      this.#cash + this.positionValue(prices).toStroops()
    );
  }

  /**
   * Verify `totalValue == initialCash + realized + unrealized - fees`.
   * Throws `AccountingIdentityError` on any mismatch.
   */
  assertIdentity(prices: PriceSet): void {
    const lhs = this.totalValue(prices).toStroops();
    const rhs =
      this.initialCash.toStroops() +
      this.#realized +
      this.unrealized(prices).toStroops() -
      this.#fees;
    if (lhs !== rhs) {
      throw new AccountingIdentityError(
        `accounting identity violated: total ${lhs} != conserved ${rhs} (stroops)`
      );
    }
  }
}
