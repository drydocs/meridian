import { Decimal } from "./decimal";
import {
  FixedPointDecimal,
  TimestampOutOfRangeError,
  UnknownAssetError,
} from "./types";
import type { AssetSymbol, PriceFeed, SimulationTimestamp } from "./types";
import { XorShift64, derivePathSeed } from "./rng";

/** Intermediate precision, finer than the stroop scale of the returned prices. */
export const GBM_WORKING_SCALE = 18;

const DEFAULT_STEP_SIZE = "1";
const DEFAULT_ASSET: AssetSymbol = "USDC";
const DEFAULT_START_TIMESTAMP = 0;
/** `Math.exp` overflows to Infinity beyond roughly this magnitude. */
const MAX_EXPONENT = 700;

export type DecimalInput = Decimal | FixedPointDecimal | string;

export interface GbmPathOptions {
  startPrice: DecimalInput;
  /** Drift per unit time. */
  drift: DecimalInput;
  /** Volatility per unit time. */
  volatility: DecimalInput;
  steps: number;
  seed: bigint;
  /** Length of one step, in the same time units as the drift and volatility. */
  stepSize?: DecimalInput;
}

export interface GbmFeedOptions extends GbmPathOptions {
  asset?: AssetSymbol;
  startTimestamp?: SimulationTimestamp;
}

function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) {
    return value.rescale(GBM_WORKING_SCALE);
  }
  if (value instanceof FixedPointDecimal) {
    return Decimal.fromStroops(value.toStroops()).rescale(GBM_WORKING_SCALE);
  }
  return Decimal.fromString(value, GBM_WORKING_SCALE);
}

function decimalFromNumber(value: number): Decimal {
  return Decimal.fromString(
    value.toFixed(GBM_WORKING_SCALE),
    GBM_WORKING_SCALE
  );
}

/**
 * Standard normal deviate via Box-Muller. The first uniform is drawn from
 * (0, 1] so that `log` is always finite and no rejection loop is needed.
 */
function normalDraw(rng: XorShift64): number {
  const u1 = 1 - rng.nextFloat();
  const u2 = rng.nextFloat();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function expToDecimal(exponent: Decimal): Decimal {
  const asNumber = Number(exponent.toString());
  if (!Number.isFinite(asNumber) || Math.abs(asNumber) > MAX_EXPONENT) {
    throw new RangeError(
      `GBM exponent ${exponent.toString()} is outside the representable range`
    );
  }
  return decimalFromNumber(Math.exp(asNumber));
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative integer, received: ${value}`
    );
  }
}

/**
 * One GBM path, starting at `startPrice` and advancing `steps` times:
 * `S(t+dt) = S(t) * exp((drift - volatility^2 / 2) * dt + volatility * sqrt(dt) * Z)`.
 * The returned array has `steps + 1` entries, index 0 being the start price.
 */
export function generateGbmPath(options: GbmPathOptions): FixedPointDecimal[] {
  assertCount(options.steps, "Steps");

  const startPrice = toDecimal(options.startPrice);
  const drift = toDecimal(options.drift);
  const volatility = toDecimal(options.volatility);
  const stepSize = toDecimal(options.stepSize ?? DEFAULT_STEP_SIZE);

  const stepSizeAsNumber = Number(stepSize.toString());
  if (!(stepSizeAsNumber >= 0)) {
    throw new RangeError(
      `Step size must be non-negative, received: ${stepSize.toString()}`
    );
  }

  const sqrtStepSize = decimalFromNumber(Math.sqrt(stepSizeAsNumber));
  const halfVariance = volatility.mul(volatility).div("2").mul(stepSize);
  const driftPerStep = drift.mul(stepSize).sub(halfVariance);
  const volatilityPerStep = volatility.mul(sqrtStepSize);

  const rng = new XorShift64(options.seed);
  const path: FixedPointDecimal[] = [
    FixedPointDecimal.fromStroops(startPrice.toStroops()),
  ];

  let price = startPrice;
  for (let step = 0; step < options.steps; step += 1) {
    const shock = decimalFromNumber(normalDraw(rng)).mul(volatilityPerStep);
    price = price.mul(expToDecimal(driftPerStep.add(shock)));
    path.push(FixedPointDecimal.fromStroops(price.toStroops()));
  }

  return path;
}

/**
 * `count` paths from a single seed, path `i` seeded by `derivePathSeed(seed, i)`
 * so any one path can be regenerated on its own.
 */
export function generateGbmPaths(
  options: GbmPathOptions,
  count: number
): FixedPointDecimal[][] {
  assertCount(count, "Path count");

  const paths: FixedPointDecimal[][] = [];
  for (let index = 0; index < count; index += 1) {
    paths.push(
      generateGbmPath({ ...options, seed: derivePathSeed(options.seed, index) })
    );
  }
  return paths;
}

/** Serves a generated path through the `PriceFeed` interface. */
export class GbmPriceFeed implements PriceFeed {
  readonly #path: readonly FixedPointDecimal[];
  readonly #asset: AssetSymbol;
  readonly #startTimestamp: SimulationTimestamp;

  private constructor(
    path: readonly FixedPointDecimal[],
    asset: AssetSymbol,
    startTimestamp: SimulationTimestamp
  ) {
    this.#path = path;
    this.#asset = asset;
    this.#startTimestamp = startTimestamp;
  }

  static generate(options: GbmFeedOptions): GbmPriceFeed {
    return new GbmPriceFeed(
      generateGbmPath(options),
      options.asset ?? DEFAULT_ASSET,
      options.startTimestamp ?? DEFAULT_START_TIMESTAMP
    );
  }

  get path(): readonly FixedPointDecimal[] {
    return this.#path;
  }

  getSpotPrice(
    asset: AssetSymbol,
    timestamp: SimulationTimestamp
  ): FixedPointDecimal {
    if (asset !== this.#asset) {
      throw new UnknownAssetError(asset);
    }

    const index = timestamp - this.#startTimestamp;
    const lastIndex = this.#path.length - 1;
    if (!Number.isInteger(index) || index < 0 || index > lastIndex) {
      throw new TimestampOutOfRangeError(
        timestamp,
        this.#startTimestamp,
        this.#startTimestamp + lastIndex
      );
    }

    return this.#path[index]!;
  }
}
