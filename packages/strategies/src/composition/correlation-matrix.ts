import { Decimal } from "../decimal";
import { decimalSqrt } from "../risk-metrics";

/**
 * Pairwise return correlation for composed strategy members (#1201).
 *
 * A composition is meant to diversify, but two members can each look sound in
 * isolation while rising and falling together. This module computes the
 * Pearson correlation of the members' return series so the composition view
 * can distinguish a genuine diversifier from a duplicate position.
 *
 * Zero-variance members have no defined correlation with anything. They are
 * surfaced as `undefined` off the diagonal instead of producing `NaN`; the
 * diagonal stays at 1 so the matrix remains a correlation matrix.
 */

const MATRIX_SCALE = 18;

export interface MemberReturnSeries {
  /** Stable member id. Must be non-empty and unique. */
  readonly id: string;
  /** Per-period returns for the member, in member declaration order. */
  readonly returns: readonly Decimal[];
}

/** `undefined` means the pair's correlation is undefined (zero variance). */
export type CorrelationEntry = Decimal | undefined;

/** Symmetric matrix in the same order as the input members. */
export type CorrelationMatrix = readonly (readonly CorrelationEntry[])[];

export type CorrelationMatrixErrorReason =
  "empty-id" | "duplicate-id" | "length-mismatch";

export class CorrelationMatrixError extends Error {
  readonly reason: CorrelationMatrixErrorReason;

  constructor(reason: CorrelationMatrixErrorReason, message: string) {
    super(message);
    this.name = "CorrelationMatrixError";
    this.reason = reason;
  }
}

/**
 * Pearson correlation matrix of the supplied member return series.
 *
 * The matrix is symmetric, has a unit diagonal, and has the same order as
 * `memberReturns`. An entry is `undefined` when either member has zero
 * variance (including series shorter than two observations).
 *
 * @throws {CorrelationMatrixError} for empty/duplicate ids or series of
 * different lengths.
 */
export function correlationMatrix(
  memberReturns: readonly MemberReturnSeries[]
): CorrelationMatrix {
  const memberCount = memberReturns.length;
  if (memberCount === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const seriesLength = memberReturns[0]!.returns.length;
  for (const member of memberReturns) {
    if (member.id.trim().length === 0) {
      throw new CorrelationMatrixError(
        "empty-id",
        "member ids must be non-empty"
      );
    }
    if (seenIds.has(member.id)) {
      throw new CorrelationMatrixError(
        "duplicate-id",
        `duplicate member id "${member.id}"`
      );
    }
    seenIds.add(member.id);
    if (member.returns.length !== seriesLength) {
      throw new CorrelationMatrixError(
        "length-mismatch",
        `member "${member.id}" has ${member.returns.length} returns; expected ${seriesLength}`
      );
    }
  }

  const scale = workingScale(memberReturns);
  const one = Decimal.one(scale);
  const minusOne = one.neg();
  const matrix: CorrelationEntry[][] = Array.from({ length: memberCount }, () =>
    new Array<CorrelationEntry>(memberCount).fill(undefined)
  );

  const normalized = memberReturns.map((member) =>
    member.returns.map((value) => value.rescale(scale))
  );
  const moments = normalized.map((returns) => momentsOf(returns, scale));

  for (let left = 0; left < memberCount; left += 1) {
    matrix[left]![left] = one;
    for (let right = left + 1; right < memberCount; right += 1) {
      if (seriesLength < 2) {
        continue;
      }
      const leftMoments = moments[left]!;
      const rightMoments = moments[right]!;
      if (leftMoments.variance.isZero() || rightMoments.variance.isZero()) {
        continue;
      }

      const covariance = covarianceOf(
        normalized[left]!,
        normalized[right]!,
        leftMoments.mean,
        rightMoments.mean,
        scale
      );
      const denominator = decimalSqrt(leftMoments.variance).mul(
        decimalSqrt(rightMoments.variance)
      );
      let correlation = covariance.div(denominator);
      if (correlation.gt(one)) correlation = one;
      if (correlation.lt(minusOne)) correlation = minusOne;

      matrix[left]![right] = correlation;
      matrix[right]![left] = correlation;
    }
  }

  return matrix.map((row) => [...row]);
}

interface Moments {
  readonly mean: Decimal;
  readonly variance: Decimal;
}

function momentsOf(returns: readonly Decimal[], scale: number): Moments {
  if (returns.length === 0) {
    return { mean: Decimal.zero(scale), variance: Decimal.zero(scale) };
  }

  const count = Decimal.fromBigInt(BigInt(returns.length), 0);
  let sum = Decimal.zero(scale);
  for (const value of returns) {
    sum = sum.add(value);
  }
  const mean = sum.div(count);

  let squaredDeviations = Decimal.zero(scale);
  for (const value of returns) {
    const deviation = value.sub(mean);
    squaredDeviations = squaredDeviations.add(deviation.mul(deviation));
  }

  return { mean, variance: squaredDeviations.div(count) };
}

function covarianceOf(
  left: readonly Decimal[],
  right: readonly Decimal[],
  leftMean: Decimal,
  rightMean: Decimal,
  scale: number
): Decimal {
  let productSum = Decimal.zero(scale);
  for (let index = 0; index < left.length; index += 1) {
    productSum = productSum.add(
      left[index]!.sub(leftMean).mul(right[index]!.sub(rightMean))
    );
  }
  return productSum.div(Decimal.fromBigInt(BigInt(left.length), 0));
}

function workingScale(memberReturns: readonly MemberReturnSeries[]): number {
  let scale = MATRIX_SCALE;
  for (const member of memberReturns) {
    for (const value of member.returns) {
      if (value.scale > scale) {
        scale = value.scale;
      }
    }
  }
  return scale;
}
