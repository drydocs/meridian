import { FixedPointDecimal, STROOPS_PER_UNIT } from "./types";
import type { AssetSymbol } from "./types";

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

/** Small deterministic PRNG (mulberry32), used when no `rng` is injected. */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws via Box-Muller, one pair per two calls. */
function normalSource(rng: RandomSource): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return z;
    }
    let u = rng();
    while (u <= 0) u = rng();
    const v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
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
  seed: number;
  /** Optional shared RNG (uniform [0,1)); overrides `seed`. */
  rng?: RandomSource;
}

export type CorrelatedPaths = Map<AssetSymbol, FixedPointDecimal[]>;

const toNumber = (d: FixedPointDecimal): number =>
  Number(d.toStroops()) / Number(STROOPS_PER_UNIT);

/**
 * Generate correlated geometric Brownian motion paths for several assets.
 * Inputs are fixed-point decimals; the same seed reproduces identical path
 * sets. Driving noise is correlated as z = L * eps with L the Cholesky
 * factor of the correlation matrix. Output prices are rounded to 7 places.
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

  const dt = toNumber(config.dt);
  const sqrtDt = Math.sqrt(dt);
  const normal = normalSource(config.rng ?? seededRandom(config.seed));
  const mu = assets.map((a) => toNumber(a.drift));
  const sigma = assets.map((a) => toNumber(a.volatility));
  const price = assets.map((a) => toNumber(a.initialPrice));
  const paths = assets.map((a) => [a.initialPrice]);

  const eps = new Array<number>(n).fill(0);
  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < n; i++) eps[i] = normal();
    for (let i = 0; i < n; i++) {
      let z = 0;
      const Li = L[i] as number[];
      for (let k = 0; k <= i; k++) z += (Li[k] as number) * (eps[k] as number);
      const s = sigma[i] as number;
      const growth = ((mu[i] as number) - 0.5 * s * s) * dt + s * sqrtDt * z;
      price[i] = (price[i] as number) * Math.exp(growth);
      const stroops = Math.round(
        (price[i] as number) * Number(STROOPS_PER_UNIT)
      );
      if (!Number.isFinite(stroops) || !Number.isSafeInteger(stroops)) {
        throw new InvalidPathConfigError(
          `${assets[i]?.asset}: simulated price left the representable range`
        );
      }
      (paths[i] as FixedPointDecimal[]).push(
        FixedPointDecimal.fromStroops(BigInt(stroops))
      );
    }
  }

  const out: CorrelatedPaths = new Map();
  assets.forEach((a, i) => out.set(a.asset, paths[i] as FixedPointDecimal[]));
  return out;
}
