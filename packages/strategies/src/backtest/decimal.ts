/**
 * Fixed-point decimal primitives for the backtest engine. Every monetary
 * amount, price and rate in the engine is a `Fixed`: a bigint scaled by
 * `FIXED_SCALE` (1e8). IEEE-754 floats are never used for money or rates
 * (#856), so results are exact and reproducible run to run.
 */

export type Fixed = bigint;

/** Eight decimal places of precision: one unit === 1e-8. */
export const FIXED_SCALE = 100_000_000n;

export const ZERO: Fixed = 0n;

/** Whole units to a `Fixed` value, e.g. `whole(10n)` === `10.0`. */
export function whole(units: bigint): Fixed {
  return units * FIXED_SCALE;
}

/** Multiplies two `Fixed` values, flooring to the scale. */
export function mulFixed(a: Fixed, b: Fixed): Fixed {
  return (a * b) / FIXED_SCALE;
}

/** Divides `a` by `b` (both `Fixed`), flooring to the scale. */
export function divFixed(a: Fixed, b: Fixed): Fixed {
  if (b === ZERO) throw new RangeError("divFixed: division by zero");
  return (a * FIXED_SCALE) / b;
}

/** Applies an integer basis-point rate to a `Fixed` value (floored). */
export function applyBps(value: Fixed, bps: bigint): Fixed {
  return (value * bps) / 10_000n;
}

/** Parses a plain decimal string ("12", "-0.5") into a `Fixed` value. */
export function parseFixed(text: string): Fixed {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`parseFixed: invalid decimal "${text}"`);
  const sign = match[1] ?? "";
  const wholePart = match[2] ?? "0";
  const fracPart = match[3] ?? "";
  const frac = (fracPart + "00000000").slice(0, 8);
  const value = BigInt(wholePart) * FIXED_SCALE + BigInt(frac);
  return sign === "-" ? -value : value;
}

/**
 * Canonical decimal text for a `Fixed` value: no exponent, no trailing zeros,
 * no leading "+". Identical values always render byte-identically.
 */
export function formatFixed(value: Fixed): string {
  const negative = value < ZERO;
  const abs = negative ? -value : value;
  const wholePart = abs / FIXED_SCALE;
  const fracPart = (abs % FIXED_SCALE)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracPart ? `${sign}${wholePart}.${fracPart}` : `${sign}${wholePart}`;
}
