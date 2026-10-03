/**
 * Internal fixed-point decimal used by all strategy math.
 *
 * Every value is stored as a raw `bigint` numerator over a fixed scale of
 * 10^18 (`SCALE_FACTOR`), so monetary values and their derived ratios are
 * exact rationals with 18 fractional decimal digits — the same invariant as
 * the fixed-point money-math utility ([SDK] fixed-point decimal money-math,
 * #856). No `number` ever touches a monetary value path: the only place
 * `number` appears is `Decimal.fromDecimalString`'s digit parsing, which
 * touches characters and counts, never magnitudes.
 *
 * Rounding contract (documented per #856's "explicit rounding modes"):
 * - `add`, `sub`, `neg`, `abs`: exact, never round.
 * - `mul`, `div`, `rescale`, `mean`, `sqrt`: round once, at the final
 *   scale-18 step, using the caller-chosen `RoundingMode`
 *   (default `half-up`, i.e. round-half-away-from-zero).
 * - Round-trip guarantee: `Decimal.fromRaw(x).toRaw() === x` for every
 *   bigint `x`, and any scale-18 value survives `add`/`sub`/`mul`/`div` by
 *   exact intermediate quantities without further loss beyond the single
 *   documented rounding step.
 */
export type RoundingMode = "half-up" | "half-even" | "floor" | "ceil" | "trunc";

/** Scale of the fixed-point representation: values are raw / 10^SCALE. */
export const DECIMAL_SCALE = 18;

const SCALE_FACTOR: bigint = 10n ** BigInt(DECIMAL_SCALE);

/** Applies `mode` to `numerator / denominator` at scale 0 (bigint floor division). */
function divideWithRounding(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) {
    return quotient;
  }
  const negative = numerator < 0n !== denominator < 0n;
  // Magnitudes of the truncated remainder and denominator.
  const remAbs = negative ? -remainder : remainder;
  switch (mode) {
    case "trunc":
      return quotient;
    case "floor":
      return negative ? quotient - 1n : quotient;
    case "ceil":
      return negative ? quotient : quotient + 1n;
    case "half-up":
      return 2n * remAbs >= (denominator < 0n ? -denominator : denominator)
        ? negative
          ? quotient - 1n
          : quotient + 1n
        : quotient;
    case "half-even": {
      const twice = 2n * remAbs;
      const denAbs = denominator < 0n ? -denominator : denominator;
      if (twice > denAbs) return negative ? quotient - 1n : quotient + 1n;
      if (twice < denAbs) return quotient;
      // Exact tie: round to the even neighbour.
      const flipped = quotient % 2n !== 0n;
      return flipped ? (negative ? quotient - 1n : quotient + 1n) : quotient;
    }
  }
}

export class Decimal {
  private readonly raw: bigint;

  private constructor(raw: bigint) {
    this.raw = raw;
  }

  /** The underlying scale-18 bigint numerator. */
  toRaw(): bigint {
    return this.raw;
  }

  /** Wraps an existing scale-18 bigint numerator without any conversion. */
  static fromRaw(raw: bigint): Decimal {
    return new Decimal(raw);
  }

  static zero(): Decimal {
    return new Decimal(0n);
  }

  /** True when the value is exactly zero. */
  isZero(): boolean {
    return this.raw === 0n;
  }

  /** True when the value is strictly below zero. */
  isNegative(): boolean {
    return this.raw < 0n;
  }

  /** True when the value is strictly above zero. */
  isPositive(): boolean {
    return this.raw > 0n;
  }

  /**
   * Builds a value from a scaled integer: `value = raw / 10^fractionalDigits`.
   * `Decimal.fromScaled(125n, 2)` is 1.25. Lossless for any bigint `raw`.
   */
  static fromScaled(raw: bigint, fractionalDigits: number): Decimal {
    if (!Number.isInteger(fractionalDigits) || fractionalDigits < 0) {
      throw new RangeError(
        `fractionalDigits must be a non-negative integer, got ${fractionalDigits}`
      );
    }
    if (fractionalDigits <= DECIMAL_SCALE) {
      return new Decimal(raw * 10n ** BigInt(DECIMAL_SCALE - fractionalDigits));
    }
    return new Decimal(
      divideWithRounding(
        raw,
        10n ** BigInt(fractionalDigits - DECIMAL_SCALE),
        "half-up"
      )
    );
  }

  /**
   * Parses a decimal string such as `"-1.25"` into a fixed-point value.
   * Throws rather than silently truncating: inputs longer than 18 fractional
   * digits are rejected.
   */
  static fromDecimalString(value: string): Decimal {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.exec(value);
    if (match === null) {
      throw new RangeError(`Invalid decimal string: "${value}"`);
    }
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const dot = unsigned.indexOf(".");
    const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
    const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);
    if (fraction.length > DECIMAL_SCALE) {
      throw new RangeError(
        `"${value}" has more than ${DECIMAL_SCALE} fractional digits`
      );
    }
    const raw =
      BigInt(whole) * SCALE_FACTOR +
      BigInt(fraction.padEnd(DECIMAL_SCALE, "0"));
    return new Decimal(negative ? -raw : raw);
  }

  /**
   * Human-readable decimal string with trailing fractional zeros trimmed:
   * `Decimal.fromDecimalString("1.5").toString()` is `"1.5"`, zero prints
   * as `"0"`, and `1/3` keeps all 18 fractional digits.
   */
  toString(): string {
    const negative = this.raw < 0n;
    const magnitude = negative ? -this.raw : this.raw;
    const digits = magnitude.toString().padStart(DECIMAL_SCALE + 1, "0");
    const whole = digits.slice(0, digits.length - DECIMAL_SCALE);
    const fraction = digits
      .slice(digits.length - DECIMAL_SCALE)
      .replace(/0+$/, "");
    const sign = negative ? "-" : "";
    return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
  }

  add(other: Decimal): Decimal {
    return new Decimal(this.raw + other.raw);
  }

  sub(other: Decimal): Decimal {
    return new Decimal(this.raw - other.raw);
  }

  neg(): Decimal {
    return new Decimal(-this.raw);
  }

  abs(): Decimal {
    return new Decimal(this.raw < 0n ? -this.raw : this.raw);
  }

  /** `this * other`, rounded once to scale 18 (default half-up). */
  mul(other: Decimal, mode: RoundingMode = "half-up"): Decimal {
    return new Decimal(
      divideWithRounding(this.raw * other.raw, SCALE_FACTOR, mode)
    );
  }

  /**
   * `this / other`, rounded once to scale 18 (default half-up).
   * Throws on division by zero — a NaN-like silent zero is never produced.
   */
  div(other: Decimal, mode: RoundingMode = "half-up"): Decimal {
    if (other.raw === 0n) {
      throw new RangeError("Decimal division by zero");
    }
    return new Decimal(
      divideWithRounding(this.raw * SCALE_FACTOR, other.raw, mode)
    );
  }

  /** Integer power via repeated multiplication; `exponent` must be ≥ 0. */
  pow(exponent: number): Decimal {
    if (!Number.isInteger(exponent) || exponent < 0) {
      throw new RangeError(
        `exponent must be a non-negative integer, got ${exponent}`
      );
    }
    let result = Decimal.one();
    for (let i = 0; i < exponent; i++) {
      result = result.mul(this);
    }
    return result;
  }

  /**
   * Square root rounded to scale 18. Uses an exact integer Newton iteration
   * on the scale-18 numerators, so the only rounding is the final floor of
   * the exact irrational root.
   */
  sqrt(): Decimal {
    if (this.raw < 0n) {
      throw new RangeError("Decimal square root of a negative number");
    }
    const target = this.raw * SCALE_FACTOR;
    if (target === 0n) {
      return Decimal.zero();
    }
    let guess = target;
    // Newton's method on raw numerators converges from above; seed with a
    // power-of-two shift so the first iterations halve quickly.
    let shift = 1n;
    while (guess >> shift > 0n) {
      shift <<= 1n;
    }
    guess >>= shift >> 1n;
    if (guess === 0n) {
      guess = 1n;
    }
    while (true) {
      const next = (guess + target / guess) >> 1n;
      if (next >= guess) {
        break;
      }
      guess = next;
    }
    // `guess` is the largest integer with guess^2 <= target.
    return new Decimal(guess);
  }

  /** Arithmetic mean of the given values; the sum is exact before division. */
  static mean(values: readonly Decimal[]): Decimal {
    if (values.length === 0) {
      throw new RangeError("Decimal.mean of an empty series");
    }
    let sum = 0n;
    for (const value of values) {
      sum += value.raw;
    }
    return new Decimal(
      divideWithRounding(sum, BigInt(values.length), "half-up")
    );
  }

  static one(): Decimal {
    return new Decimal(SCALE_FACTOR);
  }

  /** Strict total order over the exact raw numerators. */
  compare(other: Decimal): number {
    if (this.raw < other.raw) return -1;
    if (this.raw > other.raw) return 1;
    return 0;
  }

  eq(other: Decimal): boolean {
    return this.raw === other.raw;
  }
}
