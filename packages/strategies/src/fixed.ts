/** Default scale: seven decimal places, matching Stellar stroops. */
export const DEFAULT_SCALE = 10_000_000n;

export type RoundingMode = "down" | "up" | "nearest";

function roundedQuotient(
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode,
): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  if (rounding === "nearest") {
    return quotient + (remainder * 2n >= denominator ? 1n : 0n);
  }

  const positive = numerator >= 0n;
  if (rounding === "up") return quotient + (positive ? 1n : -1n);
  return quotient;
}

function assertSameScale(left: FixedDecimal, right: FixedDecimal): void {
  if (left.scale !== right.scale) {
    throw new RangeError("fixed-point values must use the same scale");
  }
}

/** A fixed-point decimal represented entirely by bigint arithmetic. */
export class FixedDecimal {
  readonly raw: bigint;
  readonly scale: bigint;

  private constructor(raw: bigint, scale: bigint) {
    if (scale <= 0n) throw new RangeError("scale must be positive");
    this.raw = raw;
    this.scale = scale;
  }

  static fromScaled(raw: bigint, scale = DEFAULT_SCALE): FixedDecimal {
    return new FixedDecimal(raw, scale);
  }

  static fromInteger(value: bigint, scale = DEFAULT_SCALE): FixedDecimal {
    return new FixedDecimal(value * scale, scale);
  }

  static fromString(
    value: string,
    scale = DEFAULT_SCALE,
    rounding: RoundingMode = "nearest",
  ): FixedDecimal {
    const normalized = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
      throw new RangeError(`invalid fixed-point value: ${value}`);
    }

    const negative = normalized.startsWith("-");
    const unsigned = negative ? normalized.slice(1) : normalized;
    const [whole, fraction = ""] = unsigned.split(".");
    const digits = fraction.length;
    const unscaled = BigInt(`${whole}${fraction}` || "0");
    const sourceScale = 10n ** BigInt(digits);
    const raw = roundedQuotient(unscaled * scale, sourceScale, rounding);
    return new FixedDecimal(negative ? -raw : raw, scale);
  }

  add(other: FixedDecimal): FixedDecimal {
    assertSameScale(this, other);
    return new FixedDecimal(this.raw + other.raw, this.scale);
  }

  subtract(other: FixedDecimal): FixedDecimal {
    assertSameScale(this, other);
    return new FixedDecimal(this.raw - other.raw, this.scale);
  }

  multiply(other: FixedDecimal, rounding: RoundingMode = "nearest"): FixedDecimal {
    assertSameScale(this, other);
    return new FixedDecimal(
      roundedQuotient(this.raw * other.raw, this.scale, rounding),
      this.scale,
    );
  }

  multiplyInteger(value: bigint): FixedDecimal {
    return new FixedDecimal(this.raw * value, this.scale);
  }

  divide(other: FixedDecimal, rounding: RoundingMode = "nearest"): FixedDecimal {
    assertSameScale(this, other);
    if (other.raw === 0n) throw new RangeError("cannot divide by zero");
    return new FixedDecimal(
      roundedQuotient(this.raw * this.scale, other.raw, rounding),
      this.scale,
    );
  }

  compare(other: FixedDecimal): -1 | 0 | 1 {
    assertSameScale(this, other);
    return this.raw < other.raw ? -1 : this.raw > other.raw ? 1 : 0;
  }

  toString(): string {
    const negative = this.raw < 0n;
    const absolute = negative ? -this.raw : this.raw;
    const whole = absolute / this.scale;
    const fraction = (absolute % this.scale).toString().padStart(this.scale.toString().length - 1, "0");
    const trimmedFraction = fraction.replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
  }
}
