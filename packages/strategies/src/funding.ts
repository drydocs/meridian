const MAX_DECIMAL_SCALE = 1_000;

/** An exact decimal represented as coefficient / 10^scale. */
export interface FixedPointDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

/** Creates a fixed-point decimal without converting through floating point. */
export function fixedPoint(
  coefficient: bigint,
  scale: number = 0
): FixedPointDecimal {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
    throw new RangeError(`Invalid fixed-point scale: ${scale}`);
  }
  return { coefficient, scale };
}

/** Parses a base-10 decimal string exactly. Exponents and separators are not accepted. */
export function parseFixedPoint(value: string): FixedPointDecimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new TypeError(`Invalid fixed-point decimal: ${value}`);
  const fraction = match[3] ?? "";
  const sign = match[1] === "-" ? -1n : 1n;
  return fixedPoint(sign * BigInt(`${match[2]}${fraction}`), fraction.length);
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function rescale(value: FixedPointDecimal, scale: number): bigint {
  if (scale < value.scale) {
    throw new RangeError("Cannot rescale a fixed-point value without rounding");
  }
  return value.coefficient * powerOfTen(scale - value.scale);
}

function addFixedPoint(
  left: FixedPointDecimal,
  right: FixedPointDecimal
): FixedPointDecimal {
  const scale = Math.max(left.scale, right.scale);
  return fixedPoint(rescale(left, scale) + rescale(right, scale), scale);
}

function multiplyFixedPoint(
  left: FixedPointDecimal,
  right: FixedPointDecimal
): FixedPointDecimal {
  return fixedPoint(
    left.coefficient * right.coefficient,
    left.scale + right.scale
  );
}

/**
 * Signed funding rate per funding interval. A positive rate is paid by longs
 * and received by shorts; a negative rate reverses those cash flows.
 */
export interface FundingRate {
  readonly value: FixedPointDecimal;
  readonly intervalMs: number;
}

/** One funding payment observation at a simulation-clock timestamp. */
export interface FundingRatePoint {
  readonly timestampMs: number;
  readonly rate: FundingRate;
}

/**
 * Funding observations aligned to a simulation clock. A missing observation
 * is a gap and contributes zero funding; it is not interpolated or carried.
 */
export class FundingRateSeries {
  readonly clockStartMs: number;
  readonly clockStepMs: number;
  readonly rates: readonly FundingRatePoint[];
  readonly rateScale: number;

  constructor(
    clock: { readonly startMs: number; readonly stepMs: number },
    rates: readonly FundingRatePoint[]
  ) {
    if (!Number.isSafeInteger(clock.startMs)) {
      throw new RangeError("Simulation clock start must be a safe integer");
    }
    if (!Number.isSafeInteger(clock.stepMs) || clock.stepMs <= 0) {
      throw new RangeError("Simulation clock step must be a positive safe integer");
    }

    const sorted = [...rates].sort((left, right) => left.timestampMs - right.timestampMs);
    let rateScale = 0;
    for (let index = 0; index < sorted.length; index++) {
      const point = sorted[index]!;
      if (!Number.isSafeInteger(point.timestampMs)) {
        throw new RangeError("Funding timestamp must be a safe integer");
      }
      if ((point.timestampMs - clock.startMs) % clock.stepMs !== 0) {
        throw new RangeError("Funding timestamp is not aligned to the simulation clock");
      }
      if (
        !Number.isSafeInteger(point.rate.intervalMs) ||
        point.rate.intervalMs <= 0 ||
        point.rate.intervalMs % clock.stepMs !== 0
      ) {
        throw new RangeError("Funding interval must be a positive multiple of the clock step");
      }
      if ((point.timestampMs - clock.startMs) % point.rate.intervalMs !== 0) {
        throw new RangeError("Funding timestamp is not aligned to its funding interval");
      }
      if (index > 0 && sorted[index - 1]!.timestampMs === point.timestampMs) {
        throw new RangeError("Funding timestamps must be unique");
      }
      rateScale = Math.max(rateScale, point.rate.value.scale);
    }

    this.clockStartMs = clock.startMs;
    this.clockStepMs = clock.stepMs;
    this.rates = Object.freeze(sorted.map((point) => Object.freeze({ ...point })));
    this.rateScale = rateScale;
  }
}

export type FundingPositionSide = "long" | "short";

export interface FundingPosition {
  /** Absolute position notional; direction is supplied separately by `side`. */
  readonly notional: FixedPointDecimal;
  readonly side: FundingPositionSide;
}

/**
 * Accrues funding cash flow over the half-open time span [startMs, endMs).
 * Positive results are received and negative results are paid. Each observed
 * rate applies once to the notional; gaps and empty series accrue zero.
 */
export function accrueFunding(
  series: FundingRateSeries,
  position: FundingPosition,
  startMs: number,
  endMs: number
): FixedPointDecimal {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    throw new RangeError("Accrual span bounds must be safe integers");
  }
  if (startMs > endMs) throw new RangeError("Accrual span start must not exceed end");
  if (position.notional.coefficient < 0n) {
    throw new RangeError("Position notional must be non-negative");
  }

  const resultScale = position.notional.scale + series.rateScale;
  let accrued = fixedPoint(0n, resultScale);
  for (const point of series.rates) {
    if (point.timestampMs < startMs || point.timestampMs >= endMs) continue;
    const cashFlow = multiplyFixedPoint(position.notional, point.rate.value);
    const positionSign = position.side === "long" ? -1n : 1n;
    accrued = addFixedPoint(
      accrued,
      fixedPoint(cashFlow.coefficient * positionSign, cashFlow.scale)
    );
  }
  return accrued;
}