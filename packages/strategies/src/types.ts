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

  equals(other: FixedPointDecimal): boolean {
    return this.#stroops === other.#stroops;
  }

  compareTo(other: FixedPointDecimal): number {
    if (this.#stroops < other.#stroops) return -1;
    if (this.#stroops > other.#stroops) return 1;
    return 0;
  }

  add(other: FixedPointDecimal): FixedPointDecimal {
    return new FixedPointDecimal(this.#stroops + other.#stroops);
  }

  subtract(other: FixedPointDecimal): FixedPointDecimal {
    return new FixedPointDecimal(this.#stroops - other.#stroops);
  }

  /**
   * Multiply two FixedPointDecimal values.
   * Because each value carries one STROOPS_PER_UNIT factor, the raw product
   * has two factors and must be divided by STROOPS_PER_UNIT once to stay in
   * the same unit.  Integer division truncates toward zero (Banker's rounding
   * is not needed here; truncation is consistent with Stellar protocol math).
   */
  multiply(other: FixedPointDecimal): FixedPointDecimal {
    return new FixedPointDecimal(
      (this.#stroops * other.#stroops) / STROOPS_PER_UNIT
    );
  }

  /**
   * Divide this value by another.
   * Scale the numerator up by STROOPS_PER_UNIT before dividing so the result
   * stays in the same fixed-point unit.  Throws on division by zero.
   */
  divide(other: FixedPointDecimal): FixedPointDecimal {
    if (other.#stroops === 0n) {
      throw new Error("FixedPointDecimal: division by zero");
    }
    return new FixedPointDecimal(
      (this.#stroops * STROOPS_PER_UNIT) / other.#stroops
    );
  }

  isZero(): boolean {
    return this.#stroops === 0n;
  }

  isPositive(): boolean {
    return this.#stroops > 0n;
  }

  isNegative(): boolean {
    return this.#stroops < 0n;
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
