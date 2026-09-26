const MAX_SCALE = 100;

export class FixedDecimal {
  static readonly DEFAULT_SCALE = 7;

  private constructor(
    readonly units: bigint,
    readonly scale: number
  ) {}

  static fromUnits(units: bigint, scale = FixedDecimal.DEFAULT_SCALE): FixedDecimal {
    FixedDecimal.validateScale(scale);
    return new FixedDecimal(units, scale);
  }

  static fromString(
    value: string,
    scale = FixedDecimal.DEFAULT_SCALE
  ): FixedDecimal {
    FixedDecimal.validateScale(scale);
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new TypeError(`Invalid decimal value: ${value}`);

    const sign = match[1] === "-" ? -1n : 1n;
    const whole = match[2];
    const fraction = match[3] ?? "";
    if (!whole) throw new TypeError(`Invalid decimal value: ${value}`);
    if (fraction.length > scale) {
      throw new RangeError(`Decimal value exceeds configured scale ${scale}`);
    }

    const factor = 10n ** BigInt(scale);
    const fractionalUnits = fraction
      ? BigInt(fraction.padEnd(scale, "0"))
      : 0n;
    return new FixedDecimal(
      sign * (BigInt(whole) * factor + fractionalUnits),
      scale
    );
  }

  toString(): string {
    const sign = this.units < 0n ? "-" : "";
    const absolute = this.units < 0n ? -this.units : this.units;
    const factor = 10n ** BigInt(this.scale);
    const whole = absolute / factor;
    if (this.scale === 0) return `${sign}${whole}`;

    const fraction = (absolute % factor)
      .toString()
      .padStart(this.scale, "0")
      .replace(/0+$/, "");
    return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
  }

  equals(other: FixedDecimal): boolean {
    const scale = Math.max(this.scale, other.scale);
    return this.units * 10n ** BigInt(scale - this.scale) ===
      other.units * 10n ** BigInt(scale - other.scale);
  }

  private static validateScale(scale: number): void {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
      throw new RangeError(`Scale must be an integer between 0 and ${MAX_SCALE}`);
    }
  }
}