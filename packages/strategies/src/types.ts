import { SupportedStablecoin } from "@meridian/shared";

export const STROOPS_PER_UNIT = 10_000_000n;

export class FixedPointDecimal {
  readonly #stroops: bigint;

  private constructor(stroops: bigint) {
    this.#stroops = stroops;
  }

  static fromStroops(stroops: bigint): FixedPointDecimal {
    return new FixedPointDecimal(stroops);
  }

  static fromString(value: string): FixedPointDecimal {
    const negative = value.startsWith("-");
    const absValue = negative ? value.slice(1) : value;
    const [whole = "0", frac = ""] = absValue.split(".");
    const fracPadded = frac.padEnd(7, "0").slice(0, 7);
    const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(fracPadded);
    return new FixedPointDecimal(negative ? -stroops : stroops);
  }

  toStroops(): bigint {
    return this.#stroops;
  }

  toString(): string {
    const negative = this.#stroops < 0n;
    const abs = negative ? -this.#stroops : this.#stroops;
    const whole = abs / STROOPS_PER_UNIT;
    const remainder = abs % STROOPS_PER_UNIT;
    const sign = negative ? "-" : "";
    if (remainder === 0n) return `${sign}${whole}`;
    const decimal = remainder.toString().padStart(7, "0").replace(/0+$/, "");
    return `${sign}${whole}.${decimal}`;
  }

  add(other: FixedPointDecimal): FixedPointDecimal {
    return new FixedPointDecimal(this.#stroops + other.#stroops);
  }

  sub(other: FixedPointDecimal): FixedPointDecimal {
    return new FixedPointDecimal(this.#stroops - other.#stroops);
  }

  /**
   * Multiplies two fixed-point values, e.g. 100 * 0.003 = 0.3.
   *
   * Truncates toward zero. `Decimal.mul` in this package defaults to half-up,
   * so a result computed through this type can differ by one stroop from the
   * same computation through `Decimal`.
   */
  mul(other: FixedPointDecimal): FixedPointDecimal {
    return new FixedPointDecimal(
      (this.#stroops * other.#stroops) / STROOPS_PER_UNIT
    );
  }

  /**
   * Divides this by other. Truncates toward zero, matching `mul`.
   *
   * @throws RangeError if other is zero.
   */
  div(other: FixedPointDecimal): FixedPointDecimal {
    if (other.#stroops === 0n) throw new RangeError("division by zero");
    return new FixedPointDecimal(
      (this.#stroops * STROOPS_PER_UNIT) / other.#stroops
    );
  }

  equals(other: FixedPointDecimal): boolean {
    return this.#stroops === other.#stroops;
  }

  compareTo(other: FixedPointDecimal): number {
    if (this.#stroops < other.#stroops) return -1;
    if (this.#stroops > other.#stroops) return 1;
    return 0;
  }
}

export type AssetSymbol = SupportedStablecoin;

export type SimulationTimestamp = number;

export interface PriceFeed {
  getSpotPrice(
    asset: AssetSymbol,
    timestamp: SimulationTimestamp
  ): FixedPointDecimal;
}

export class UnknownAssetError extends Error {
  readonly asset: AssetSymbol;

  constructor(asset: AssetSymbol) {
    super(`Unknown asset: ${asset}`);
    this.name = "UnknownAssetError";
    this.asset = asset;
  }
}

export class TimestampOutOfRangeError extends Error {
  readonly timestamp: SimulationTimestamp;
  readonly minTimestamp: SimulationTimestamp | null;
  readonly maxTimestamp: SimulationTimestamp | null;

  constructor(
    timestamp: SimulationTimestamp,
    minTimestamp: SimulationTimestamp | null,
    maxTimestamp: SimulationTimestamp | null
  ) {
    const minStr =
      minTimestamp !== null
        ? new Date(minTimestamp).toISOString()
        : "unbounded";
    const maxStr =
      maxTimestamp !== null
        ? new Date(maxTimestamp).toISOString()
        : "unbounded";
    super(
      `Timestamp ${new Date(timestamp).toISOString()} outside available range [${minStr}, ${maxStr}]`
    );
    this.name = "TimestampOutOfRangeError";
    this.timestamp = timestamp;
    this.minTimestamp = minTimestamp;
    this.maxTimestamp = maxTimestamp;
  }
}

export function isUnknownAssetError(
  error: unknown
): error is UnknownAssetError {
  return error instanceof UnknownAssetError;
}

export function isTimestampOutOfRangeError(
  error: unknown
): error is TimestampOutOfRangeError {
  return error instanceof TimestampOutOfRangeError;
}

/**
 * A periodic funding rate expressed in stroops-per-unit of notional per second.
 *
 * Sign convention:
 *   positive rate → longs pay shorts (short leg *receives* funding)
 *   negative rate → shorts pay longs (short leg *pays* funding)
 *
 * Stored as a FixedPointDecimal so arithmetic stays in integer stroops with
 * no floating-point rounding.  The rate itself is dimensionless (rate per
 * second); callers supply elapsed seconds as a bigint to keep the full
 * precision path integer-only end-to-end.
 */
export interface FundingRate {
  /** The per-second rate as a FixedPointDecimal (can be negative). */
  readonly ratePerSecond: FixedPointDecimal;
}

/**
 * The short leg a funding accrual is computed against. Named to avoid
 * colliding with the portfolio's own `Position`.
 *
 * `notional` is the absolute size of the position in the base asset,
 * expressed as a FixedPointDecimal (always ≥ 0).  The sign of any accrued
 * funding is determined by the FundingRate, not by this field.
 */
export interface FundingPosition {
  readonly notional: FixedPointDecimal;
}
