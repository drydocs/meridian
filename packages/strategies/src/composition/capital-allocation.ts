import { FixedPointDecimal } from "../types";

/**
 * Largest-remainder capital allocation across composition members (#1198).
 *
 * Fixed-point division does not divide evenly, so a naive pro-rata split
 * leaves dust unassigned and breaks the engine's accounting identity. This
 * allocator assigns every stroop: each member gets the floor of its exact
 * share, then the remaining stroops go one at a time to the members with the
 * largest fractional remainders. Ties are broken by member id so a fixed
 * input always produces the same allocation regardless of declaration order.
 */

export type CapitalAllocationErrorReason =
  | "negative-total"
  | "empty-weights"
  | "empty-id"
  | "duplicate-id"
  | "negative-weight"
  | "no-positive-weight";

export class CapitalAllocationError extends Error {
  readonly reason: CapitalAllocationErrorReason;

  constructor(reason: CapitalAllocationErrorReason, message: string) {
    super(message);
    this.name = "CapitalAllocationError";
    this.reason = reason;
  }
}

export interface CapitalWeight {
  /** Stable member id. Must be non-empty and unique within the vector. */
  readonly id: string;
  /** Relative weight. Non-negative; at least one weight must be positive. */
  readonly weight: FixedPointDecimal;
}

export interface CapitalAllocation {
  readonly id: string;
  /** Exact amount assigned to the member, in stroops. */
  readonly amount: FixedPointDecimal;
}

/**
 * Split `total` across `weights` using largest-remainder apportionment.
 *
 * The returned amounts always sum exactly to `total` (no dust), and the
 * result for a given set of ids/weights is deterministic. Weights are
 * normalized, so `[1, 1]`, `[0.5, 0.5]` and `[3, 3]` all split evenly.
 *
 * @throws {CapitalAllocationError} for a negative total, empty/duplicate ids,
 * negative weights, or a weight vector with no positive entry.
 */
export function allocateCapital(
  total: FixedPointDecimal,
  weights: readonly CapitalWeight[]
): readonly CapitalAllocation[] {
  const totalStroops = total.toStroops();
  if (totalStroops < 0n) {
    throw new CapitalAllocationError(
      "negative-total",
      "total capital must not be negative"
    );
  }
  if (weights.length === 0) {
    throw new CapitalAllocationError(
      "empty-weights",
      "at least one member weight is required"
    );
  }

  const seenIds = new Set<string>();
  const weightStroops: bigint[] = [];
  let weightSum = 0n;

  for (const member of weights) {
    const id = member.id;
    if (id.trim().length === 0) {
      throw new CapitalAllocationError(
        "empty-id",
        "member ids must be non-empty"
      );
    }
    if (seenIds.has(id)) {
      throw new CapitalAllocationError(
        "duplicate-id",
        `duplicate member id "${id}"`
      );
    }
    seenIds.add(id);

    const stroops = member.weight.toStroops();
    if (stroops < 0n) {
      throw new CapitalAllocationError(
        "negative-weight",
        `weight for member "${id}" must not be negative`
      );
    }
    weightStroops.push(stroops);
    weightSum += stroops;
  }

  if (weightSum === 0n) {
    throw new CapitalAllocationError(
      "no-positive-weight",
      "at least one member weight must be positive"
    );
  }

  const amounts: bigint[] = [];
  const remainders: bigint[] = [];
  let assigned = 0n;

  for (const stroops of weightStroops) {
    const exact = totalStroops * stroops;
    const base = exact / weightSum;
    amounts.push(base);
    remainders.push(exact % weightSum);
    assigned += base;
  }

  const leftover = totalStroops - assigned;
  if (leftover > 0n) {
    const order = remainders
      .map((remainder, index) => ({ remainder, index }))
      .sort((left, right) => {
        if (left.remainder !== right.remainder) {
          return left.remainder > right.remainder ? -1 : 1;
        }
        const leftId = weights[left.index]!.id;
        const rightId = weights[right.index]!.id;
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });

    for (let offset = 0n; offset < leftover; offset += 1n) {
      const slot = order[Number(offset % BigInt(order.length))]!;
      amounts[slot.index] = amounts[slot.index]! + 1n;
    }
  }

  return weights.map((member, index) => ({
    id: member.id,
    amount: FixedPointDecimal.fromStroops(amounts[index]!),
  }));
}
