import { BacktestScenario } from "./backtest";

/**
 * Deterministic pseudo-random number generator (xorshift128+)
 * seeded with a 32-bit integer for repeatable backtest scenarios.
 */
export class DeterministicRNG {
  private s0: number;
  private s1: number;

  constructor(seed: number) {
    this.s0 = (seed ^ 0x6a09e667) >>> 0;
    this.s1 = ((seed * 1664525 + 1013904223) ^ 0xbb67ae85) >>> 0;
    if (this.s0 === 0 && this.s1 === 0) {
      this.s0 = 1;
      this.s1 = 2;
    }
  }

  /** Returns float in [0, 1) */
  next(): number {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= s1 << 23;
    this.s1 = (s1 ^ s0 ^ (s1 >>> 17) ^ (s0 >>> 26)) >>> 0;
    return ((this.s1 + s0) >>> 0) / 4294967296;
  }

  /** Standard normal distribution sample via Box-Muller */
  nextGaussian(mean = 0, stdDev = 1): number {
    let u1 = this.next();
    let u2 = this.next();
    while (u1 <= 1e-15) u1 = this.next();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * stdDev;
  }
}

export interface ScenarioGeneratorOptions {
  seed?: number;
  startPrice?: number;
  numSteps?: number;
  stepIntervalMs?: number;
  baseFundingRate?: number; // e.g. 0.0001 (1 bps)
  neutralityBandBps?: number;
}

/**
 * Generates a trending market scenario (e.g. strong upward price drift).
 */
export function generateTrendingScenario(
  options: ScenarioGeneratorOptions = {}
): BacktestScenario {
  const seed = options.seed ?? 42;
  const rng = new DeterministicRNG(seed);
  const numSteps = options.numSteps ?? 100;
  const stepIntervalMs = options.stepIntervalMs ?? 3600_000; // 1 hour
  const startTimestamp = 1_700_000_000_000;
  const startPrice = options.startPrice ?? 1.0;
  const neutralityBandBps = options.neutralityBandBps ?? 50;

  let currentSpot = startPrice;
  const steps = [];

  for (let i = 0; i < numSteps; i++) {
    const timestamp = startTimestamp + i * stepIntervalMs;
    // Positive drift of +0.15% per step with small noise
    const drift = 0.0015;
    const noise = rng.nextGaussian(0, 0.0005);
    if (i > 0) {
      currentSpot = currentSpot * (1 + drift + noise);
    }

    // In a strong uptrend, perp trades at slight premium and positive funding rate
    const basis = currentSpot * 0.0002;
    const perpPrice = currentSpot + basis;
    const fundingRate =
      (options.baseFundingRate ?? 0.0003) + rng.next() * 0.0001;

    steps.push({
      timestamp,
      spotPrice: currentSpot.toFixed(7),
      perpPrice: perpPrice.toFixed(7),
      fundingRate: fundingRate.toFixed(7),
    });
  }

  const endTimestamp = startTimestamp + (numSteps - 1) * stepIntervalMs;

  return {
    id: "scenario-trending-usdc-eurc",
    name: "Trending Market Scenario",
    description:
      "Strong upward price trend with persistent positive basis and steady funding carry",
    regime: "trending",
    asset: "USDC",
    baseAsset: "USDC",
    quoteAsset: "USD",
    seed,
    startTimestamp,
    endTimestamp,
    stepIntervalMs,
    neutralityBandBps,
    steps,
  };
}

/**
 * Generates a ranging (mean-reverting / sideways) market scenario.
 */
export function generateRangingScenario(
  options: ScenarioGeneratorOptions = {}
): BacktestScenario {
  const seed = options.seed ?? 101;
  const rng = new DeterministicRNG(seed);
  const numSteps = options.numSteps ?? 100;
  const stepIntervalMs = options.stepIntervalMs ?? 3600_000;
  const startTimestamp = 1_700_000_000_000;
  const meanPrice = options.startPrice ?? 1.0;
  const neutralityBandBps = options.neutralityBandBps ?? 50;

  let currentSpot = meanPrice;
  const steps = [];

  for (let i = 0; i < numSteps; i++) {
    const timestamp = startTimestamp + i * stepIntervalMs;
    // Mean-reversion to 1.0 (Ornstein-Uhlenbeck style)
    const reversion = (meanPrice - currentSpot) * 0.1;
    const noise = rng.nextGaussian(0, 0.002);
    if (i > 0) {
      currentSpot = currentSpot + reversion + noise;
    }

    // Spot and perp tightly oscillate around each other with modest funding
    const perpPrice = currentSpot + rng.nextGaussian(0, 0.0001);
    const fundingRate =
      (options.baseFundingRate ?? 0.0001) + rng.nextGaussian(0, 0.00002);

    steps.push({
      timestamp,
      spotPrice: currentSpot.toFixed(7),
      perpPrice: perpPrice.toFixed(7),
      fundingRate: fundingRate.toFixed(7),
    });
  }

  const endTimestamp = startTimestamp + (numSteps - 1) * stepIntervalMs;

  return {
    id: "scenario-ranging-usdc-eurc",
    name: "Ranging Market Scenario",
    description:
      "Mean-reverting sideways market oscillation with moderate funding carry",
    regime: "ranging",
    asset: "USDC",
    baseAsset: "USDC",
    quoteAsset: "USD",
    seed,
    startTimestamp,
    endTimestamp,
    stepIntervalMs,
    neutralityBandBps,
    steps,
  };
}

/**
 * Generates a high-funding market scenario with large carry yield.
 */
export function generateHighFundingScenario(
  options: ScenarioGeneratorOptions = {}
): BacktestScenario {
  const seed = options.seed ?? 777;
  const rng = new DeterministicRNG(seed);
  const numSteps = options.numSteps ?? 100;
  const stepIntervalMs = options.stepIntervalMs ?? 3600_000;
  const startTimestamp = 1_700_000_000_000;
  const startPrice = options.startPrice ?? 1.08;
  const neutralityBandBps = options.neutralityBandBps ?? 50;

  let currentSpot = startPrice;
  const steps = [];

  for (let i = 0; i < numSteps; i++) {
    const timestamp = startTimestamp + i * stepIntervalMs;
    // Small random walk on price
    const priceChange = rng.nextGaussian(0, 0.001);
    if (i > 0) {
      currentSpot = currentSpot * (1 + priceChange);
    }

    // High perp premium and high positive funding rate (e.g. 0.08% to 0.15% per step)
    const perpPrice = currentSpot * (1 + 0.0005 + rng.next() * 0.0003);
    const fundingRate =
      (options.baseFundingRate ?? 0.001) + rng.next() * 0.0005; // 10 to 15 bps / step

    steps.push({
      timestamp,
      spotPrice: currentSpot.toFixed(7),
      perpPrice: perpPrice.toFixed(7),
      fundingRate: fundingRate.toFixed(7),
    });
  }

  const endTimestamp = startTimestamp + (numSteps - 1) * stepIntervalMs;

  return {
    id: "scenario-high-funding-eurc",
    name: "High Funding Carry Scenario",
    description:
      "Elevated funding rates generating significant cash flow while maintaining neutrality",
    regime: "high-funding",
    asset: "EURC",
    baseAsset: "EURC",
    quoteAsset: "USD",
    seed,
    startTimestamp,
    endTimestamp,
    stepIntervalMs,
    neutralityBandBps,
    steps,
  };
}
