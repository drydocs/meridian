import { XorShift64 } from "./rng";
import { FixedPointDecimal } from "./types";
import { parseDecimal } from "./decimal";

function toNumber(value: string | number | FixedPointDecimal): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseDecimal(value);
  if (value instanceof FixedPointDecimal) return Number(value.toString());
  return parseDecimal(String(value));
}

export function derivePathSeed(seed: bigint, pathIndex: number): bigint {
  return seed ^ (BigInt(pathIndex) * 0x9e3779b97f4a7c15n);
}

export function generatePath(
  startPrice: string | number,
  drift: string | number | FixedPointDecimal,
  volatility: string | number | FixedPointDecimal,
  steps: number,
  seed: bigint
): number[] {
  const sp = typeof startPrice === "string" ? parseDecimal(startPrice) : startPrice;
  const d = toNumber(drift);
  const v = toNumber(volatility);

  const rng = new XorShift64(seed);
  const path: number[] = [];

  let price = sp;
  path.push(price);

  for (let i = 0; i < steps; i++) {
    const u1 = rng.nextFloat();
    const u2 = rng.nextFloat();

    // Guard against edge cases: if u1 is 0, log gives -Infinity
    // If both drift and volatility are 0, path stays at start price
    if (d === 0 && v === 0) {
      // Path stays at start price - already pushed, just add copies
      path.push(price);
      continue;
    }

    // Box-Muller transform: two uniform(0,1) -> two normal(0,1)
    // Guard against u1 = 0 which gives log(0) = -Infinity
    const safeU1 = u1 === 0 ? 1e-10 : u1;
    const z0 = Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2);

    // GBM: S_{new} = S * exp((drift - volatility^2/2) * dt + volatility * sqrt(dt) * Z)
    // With dt = 1 for unit time steps
    const driftTerm = d;
    const volSquare = v * v * 0.5;
    const volatilityTerm = v * Math.sqrt(1);
    const exponent = driftTerm - volSquare + volatilityTerm * z0;

    // Guard against NaN exponent
    const safeExponent = Number.isFinite(exponent) ? exponent : 0;

    price = price * Math.exp(safeExponent);
    path.push(price);
  }

  return path;
}

export function generateBatch(
  startPrice: string | number,
  drift: string | number | FixedPointDecimal,
  volatility: string | number | FixedPointDecimal,
  steps: number,
  count: number,
  seed: bigint
): number[][] {
  const paths: number[][] = [];

  for (let i = 0; i < count; i++) {
    const pathSeed = derivePathSeed(seed, i);
    const path = generatePath(startPrice, drift, volatility, steps, pathSeed);
    paths.push(path);
  }

  return paths;
}