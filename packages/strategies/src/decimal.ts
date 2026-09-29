export type RoundingMode = "trunc" | "floor" | "ceil" | "half-up" | "half-even";

export const DEFAULT_DECIMAL_SCALE = 7; // Stellar stroop standard (10^7)

function getScaleFactor(scale: number): bigint {
  if (scale < 0 || !Number.isInteger(scale)) {
    throw new RangeError(
      `Scale must be a non-negative integer, received: ${scale}`
    );
  }
  return 10n ** BigInt(scale);
}

function divideWithRounding(
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode = "half-up"
): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division by zero");
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  if (remainder === 0n) {
    return quotient;
  }

  const isPositiveResult =
    (numerator > 0n && denominator > 0n) ||
    (numerator < 0n && denominator < 0n);
  const sign = isPositiveResult ? 1n : -1n;
  const absRem = remainder < 0n ? -remainder : remainder;
  const absDen = denominator < 0n ? -denominator : denominator;
  const doubleAbsRem = absRem * 2n;

  switch (rounding) {
    case "trunc":
      return quotient;
    case "floor":
      return isPositiveResult ? quotient : quotient - 1n;
    case "ceil":
      return isPositiveResult ? quotient + 1n : quotient;
    case "half-up":
      if (doubleAbsRem >= absDen) {
        return quotient + sign;
      }
      return quotient;
    case "half-even":
      if (doubleAbsRem > absDen) {
        return quotient + sign;
      } else if (doubleAbsRem === absDen) {
        const isOdd = (quotient < 0n ? -quotient : quotient) % 2n === 1n;
        return isOdd ? quotient + sign : quotient;
      }
      return quotient;
  }
}

export class Decimal {
  readonly raw: bigint;
  readonly scale: number;

  constructor(raw: bigint, scale: number = DEFAULT_DECIMAL_SCALE) {
    if (scale < 0 || !Number.isInteger(scale)) {
      throw new RangeError(
        `Scale must be a non-negative integer, received: ${scale}`
      );
    }
    this.raw = raw;
    this.scale = scale;
  }

  static from(
    value: Decimal | bigint | number | string,
    scale: number = DEFAULT_DECIMAL_SCALE
  ): Decimal {
    if (value instanceof Decimal) {
      return value.scale === scale ? value : value.rescale(scale);
    }
    if (typeof value === "bigint") {
      return new Decimal(value, scale);
    }
    if (typeof value === "number") {
      return Decimal.fromString(value.toString(), scale);
    }
    if (typeof value === "string") {
      return Decimal.fromString(value, scale);
    }
    throw new TypeError("Unsupported value for Decimal.from");
  }

  static fromBigInt(
    units: bigint,
    scale: number = DEFAULT_DECIMAL_SCALE
  ): Decimal {
    return new Decimal(units, scale);
  }

  static fromStroops(stroops: bigint): Decimal {
    return new Decimal(stroops, DEFAULT_DECIMAL_SCALE);
  }

  static zero(scale: number = DEFAULT_DECIMAL_SCALE): Decimal {
    return new Decimal(0n, scale);
  }

  static one(scale: number = DEFAULT_DECIMAL_SCALE): Decimal {
    return new Decimal(getScaleFactor(scale), scale);
  }

  static fromString(
    str: string,
    scale: number = DEFAULT_DECIMAL_SCALE
  ): Decimal {
    const trimmed = str.trim();
    if (!trimmed) {
      throw new TypeError("Cannot parse empty string as Decimal");
    }

    const match = /^[+-]?\d+(?:\.\d+)?$/.exec(trimmed);
    if (!match) {
      throw new TypeError(`Invalid decimal string format: '${str}'`);
    }

    const isNegative = trimmed.startsWith("-");
    const cleanStr = trimmed.replace(/^[+-]/, "");
    const parts = cleanStr.split(".");
    const integerPart = parts[0]!;
    const fractionPart = parts[1] || "";

    const scaleFactor = getScaleFactor(scale);
    let raw = BigInt(integerPart) * scaleFactor;

    if (fractionPart.length > 0) {
      if (fractionPart.length <= scale) {
        const paddedFraction = fractionPart.padEnd(scale, "0");
        raw += BigInt(paddedFraction);
      } else {
        const relevantFraction = fractionPart.slice(0, scale);
        const excessFraction = fractionPart.slice(scale);
        let fractionNum = BigInt(relevantFraction);
        const firstExcessDigit = parseInt(excessFraction[0]!, 10);
        if (firstExcessDigit >= 5) {
          fractionNum += 1n;
        }
        raw += fractionNum;
      }
    }

    return new Decimal(isNegative ? -raw : raw, scale);
  }

  private static toDecimal(
    other: Decimal | bigint | string,
    targetScale: number
  ): Decimal {
    if (other instanceof Decimal) {
      if (other.scale === targetScale) {
        return other;
      }
      return other.rescale(targetScale);
    }
    if (typeof other === "bigint") {
      return new Decimal(other, targetScale);
    }
    if (typeof other === "string") {
      return Decimal.fromString(other, targetScale);
    }
    throw new TypeError("Unsupported operand type for Decimal");
  }

  add(other: Decimal | bigint | string): Decimal {
    const b = Decimal.toDecimal(other, this.scale);
    return new Decimal(this.raw + b.raw, this.scale);
  }

  sub(other: Decimal | bigint | string): Decimal {
    const b = Decimal.toDecimal(other, this.scale);
    return new Decimal(this.raw - b.raw, this.scale);
  }

  mul(
    other: Decimal | bigint | string,
    rounding: RoundingMode = "half-up"
  ): Decimal {
    const b = Decimal.toDecimal(other, this.scale);
    const scaleFactor = getScaleFactor(this.scale);
    const numerator = this.raw * b.raw;
    const resultRaw = divideWithRounding(numerator, scaleFactor, rounding);
    return new Decimal(resultRaw, this.scale);
  }

  div(
    other: Decimal | bigint | string,
    rounding: RoundingMode = "half-up"
  ): Decimal {
    const b = Decimal.toDecimal(other, this.scale);
    if (b.raw === 0n) {
      throw new RangeError("Division by zero");
    }
    const scaleFactor = getScaleFactor(this.scale);
    const numerator = this.raw * scaleFactor;
    const resultRaw = divideWithRounding(numerator, b.raw, rounding);
    return new Decimal(resultRaw, this.scale);
  }

  abs(): Decimal {
    return new Decimal(this.raw < 0n ? -this.raw : this.raw, this.scale);
  }

  neg(): Decimal {
    return new Decimal(-this.raw, this.scale);
  }

  rescale(newScale: number, rounding: RoundingMode = "half-up"): Decimal {
    if (newScale === this.scale) {
      return this;
    }
    if (newScale > this.scale) {
      const diff = newScale - this.scale;
      return new Decimal(this.raw * 10n ** BigInt(diff), newScale);
    }
    const diff = this.scale - newScale;
    const divisor = 10n ** BigInt(diff);
    const newRaw = divideWithRounding(this.raw, divisor, rounding);
    return new Decimal(newRaw, newScale);
  }

  eq(other: Decimal | bigint | string): boolean {
    const b = Decimal.toDecimal(other, this.scale);
    return this.raw === b.raw;
  }

  gt(other: Decimal | bigint | string): boolean {
    const b = Decimal.toDecimal(other, this.scale);
    return this.raw > b.raw;
  }

  gte(other: Decimal | bigint | string): boolean {
    const b = Decimal.toDecimal(other, this.scale);
    return this.raw >= b.raw;
  }

  lt(other: Decimal | bigint | string): boolean {
    const b = Decimal.toDecimal(other, this.scale);
    return this.raw < b.raw;
  }

  lte(other: Decimal | bigint | string): boolean {
    const b = Decimal.toDecimal(other, this.scale);
    return this.raw <= b.raw;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  isPositive(): boolean {
    return this.raw > 0n;
  }

  isNegative(): boolean {
    return this.raw < 0n;
  }

  toBigInt(): bigint {
    return this.raw;
  }

  toStroops(): bigint {
    if (this.scale === DEFAULT_DECIMAL_SCALE) {
      return this.raw;
    }
    return this.rescale(DEFAULT_DECIMAL_SCALE).raw;
  }

  toString(): string {
    const isNeg = this.raw < 0n;
    const absRaw = isNeg ? -this.raw : this.raw;
    const scaleFactor = getScaleFactor(this.scale);

    const intPart = (absRaw / scaleFactor).toString();
    if (this.scale === 0) {
      return isNeg ? `-${intPart}` : intPart;
    }

    const fracPart = (absRaw % scaleFactor)
      .toString()
      .padStart(this.scale, "0");
    const res = `${intPart}.${fracPart}`;
    return isNeg ? `-${res}` : res;
  }

  toFixed(
    decimalPlaces: number = this.scale,
    rounding: RoundingMode = "half-up"
  ): string {
    if (decimalPlaces < 0 || !Number.isInteger(decimalPlaces)) {
      throw new RangeError(
        `Decimal places must be a non-negative integer, received: ${decimalPlaces}`
      );
    }
    return this.rescale(decimalPlaces, rounding).toString();
  }
}
