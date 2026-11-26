import { Decimal } from "./decimal";
import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";
import type { AssetSymbol } from "./types";
import { XorShift64, derivePathSeed } from "./rng";

export class NotPositiveDefiniteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPositiveDefiniteError";
  }
}

export class InvalidPathConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathConfigError";
  }
}

/** Uniform [0, 1) source. Inject one to share an existing generator's RNG. */
export type RandomSource = () => number;

/** Standard normal draws via Box-Muller on the shared XorShift64 stream. */
function normalSource(rng: RandomSource): () => number {
  return () => {
    const u1 = 1 - rng();
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * Lower-triangular Cholesky factor L with L * L^T = matrix.
 * Throws `NotPositiveDefiniteError` for a non-square, asymmetric or
 * non-positive-definite (including singular) matrix.
 */
export function choleskyDecompose(
  matrix: readonly (readonly number[])[]
): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0)
  );
  for (let i = 0; i < n; i++) {
    const row = matrix[i] as readonly number[];
    if (row.length !== n) {
      throw new NotPositiveDefiniteError("matrix must be square");
    }
    for (let j = 0; j < n; j++) {
      const other = (matrix[j] as readonly number[])[i] as number;
      if (Math.abs((row[j] as number) - other) > 1e-12) {
        throw new NotPositiveDefiniteError("matrix must be symmetric");
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = (matrix[i] as readonly number[])[j] as number;
      for (let k = 0; k < j; k++) {
        sum -= (L[i] as number[])[k]! * (L[j] as number[])[k]!;
      }
      if (i === j) {
        if (!(sum > 1e-12)) {
          throw new NotPositiveDefiniteError(
            "correlation matrix is not positive definite"
          );
        }
        (L[i] as number[])[j] = Math.sqrt(sum);
      } else {
        (L[i] as number[])[j] = sum / (L[j] as number[])[j]!;
      }
    }
  }
  return L;
}

export interface AssetPathSpec {
  asset: AssetSymbol;
  initialPrice: FixedPointDecimal;
  /** Annualized drift, e.g. "0.05". */
  drift: FixedPointDecimal;
  /** Annualized volatility, e.g. "0.6". Must be >= 0. */
  volatility: FixedPointDecimal;
}

export interface CorrelatedPathConfig {
  assets: readonly AssetPathSpec[];
  /** Correlation matrix in the same order as `assets`. Unit diagonal, symmetric. */
  correlation: readonly (readonly FixedPointDecimal[])[];
  /** Number of steps; each path has `steps + 1` points including the start. */
  steps: number;
  /** Step length in years, e.g. "0.0027397" for one day. Must be > 0. */
  dt: FixedPointDecimal;
  /** Seed for the shared XorShift64 stream. A number is read as an unsigned 32 bit seed. */
  seed: bigint | number;
  /** Optional shared RNG (uniform [0,1)); overrides `seed`. */
  rng?: RandomSource;
  /** Optional path index; when set, the stream is `derivePathSeed(seed, pathIndex)`. */
  pathIndex?: number;
}

export type CorrelatedPaths = Map<AssetSymbol, FixedPointDecimal[]>;

const toDecimal = (d: FixedPointDecimal): Decimal =>
  Decimal.fromStroops(d.toStroops());

const WORKING_SCALE = 18;
const MAX_EXPONENT = 700;

const decimalFromNumber = (value: number): Decimal =>
  Decimal.fromString(value.toFixed(WORKING_SCALE), WORKING_SCALE);

const toNumber = (d: FixedPointDecimal): number =>
  Number(d.toStroops()) / Number(STROOPS_PER_UNIT);

/**
 * Generate correlated geometric Brownian motion paths for several assets.
 * Driving noise comes from the shared `XorShift64` stream (seeded via
 * `derivePathSeed` when `pathIndex` is given), so the same seed reproduces
 * identical paths. Correlated shocks are z = L * eps with L the Cholesky
 * factor of the correlation matrix. Prices use fixed-point arithmetic and
 * are stored at stroop precision.
 */
export function generateCorrelatedPaths(
  config: CorrelatedPathConfig
): CorrelatedPaths {
  const { assets, steps } = config;
  const n = assets.length;
  if (n === 0)
    throw new InvalidPathConfigError("at least one asset is required");
  if (!Number.isInteger(steps) || steps < 0) {
    throw new InvalidPathConfigError("steps must be a non-negative integer");
  }
  if (new Set(assets.map((a) => a.asset)).size !== n) {
    throw new InvalidPathConfigError("assets must be unique");
  }
  if (config.dt.toStroops() <= 0n) {
    throw new InvalidPathConfigError("dt must be positive");
  }
  if (config.correlation.length !== n) {
    throw new NotPositiveDefiniteError(
      "correlation matrix size must match asset count"
    );
  }
  const corr = config.correlation.map((row) => row.map(toNumber));
  for (let i = 0; i < n; i++) {
    if (
      (config.correlation[i] as readonly FixedPointDecimal[])[
        i
      ]?.toStroops() !== STROOPS_PER_UNIT
    ) {
      throw new NotPositiveDefiniteError(
        "correlation matrix must have a unit diagonal"
      );
    }
  }
  const L = choleskyDecompose(corr);

  for (const a of assets) {
    if (a.initialPrice.toStroops() <= 0n) {
      throw new InvalidPathConfigError(
        `${a.asset}: initialPrice must be positive`
      );
    }
    if (a.volatility.toStroops() < 0n) {
      throw new InvalidPathConfigError(`${a.asset}: volatility must be >= 0`);
    }
  }

  const baseSeed =
    typeof config.seed === "bigint" ? config.seed : BigInt(config.seed >>> 0);
  const seed =
    config.pathIndex === undefined
      ? baseSeed
      : derivePathSeed(baseSeed, config.pathIndex);
  const generator = new XorShift64(seed);
  const draw = normalSource(config.rng ?? (() => generator.nextFloat()));

  const dt = toDecimal(config.dt).rescale(WORKING_SCALE);
  const sqrtDt = decimalFromNumber(Math.sqrt(toNumber(config.dt)));
  const mu = assets.map((a) => toDecimal(a.drift).rescale(WORKING_SCALE));
  const sigma = assets.map((a) =>
    toDecimal(a.volatility).rescale(WORKING_SCALE)
  );
  const price = assets.map((a) =>
    toDecimal(a.initialPrice).rescale(WORKING_SCALE)
  );
  const paths = assets.map((a) => [a.initialPrice]);

  const half = Decimal.fromString("0.5", WORKING_SCALE);
  const eps = new Array<number>(n).fill(0);
  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < n; i++) eps[i] = draw();
    for (let i = 0; i < n; i++) {
      let z = 0;
      const Li = L[i] as number[];
      for (let k = 0; k <= i; k++) z += (Li[k] as number) * (eps[k] as number);
      const zDec = decimalFromNumber(z);
      const s = sigma[i] as Decimal;
      const variance = s.mul(s).mul(half).mul(dt);
      const growth = mu[i]!.mul(dt).sub(variance).add(s.mul(sqrtDt).mul(zDec));
      const exponent = Number(growth.toString());
      if (!Number.isFinite(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
        throw new InvalidPathConfigError(
          `${assets[i]?.asset}: simulated price left the representable range`
        );
      }
      price[i] = price[i]!.mul(decimalFromNumber(Math.exp(exponent)));
      const stroopPrice = FixedPointDecimal.fromStroops(
        price[i]!.rescale(7).toStroops()
      );
      (paths[i] as FixedPointDecimal[]).push(stroopPrice);
    }
  }

  const out: CorrelatedPaths = new Map();
  assets.forEach((a, i) => out.set(a.asset, paths[i] as FixedPointDecimal[]));
  return out;
}
