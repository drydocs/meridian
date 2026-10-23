/**
 * Composition constraint engine (#1199).
 *
 * A composition is exactly where hidden concentration appears: the same asset
 * can be reached through several members at once, but no single member shows
 * the combined exposure. This module validates a composition against explicit
 * limits and returns typed violations so the caller can either reject the
 * composition or clamp it before applying member orders.
 *
 * Two enforcement policies are supported:
 *   - "reject": throw a `CompositionConstraintError` naming each violation.
 *   - "clamp":  reduce offending orders before they are applied and return a
 *               `ClampResult` describing what was trimmed.
 *
 * Constraints are validated at init and after every rebalance. Members never
 * mutate one another's orders; the composition applies the policy when merging
 * member orders.
 */
import { FixedPointDecimal } from "../types";
import type { AssetSymbol } from "../types";
import type { Order, PortfolioView } from "../strategy";

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Declarative limits on a composition. All fields are optional; supply only
 * the constraints that matter for your composition.
 */
export interface CompositionConstraints {
  /**
   * Maximum fraction of total portfolio value that any single member may
   * represent (0 < maxMemberWeight ≤ 1). Checked after rebalance.
   */
  readonly maxMemberWeight?: FixedPointDecimal | undefined;

  /**
   * Maximum aggregate exposure per asset across all members, expressed as a
   * fraction of total portfolio value (0 < maxAggregateExposure ≤ 1). This
   * is the key check a per-member limit cannot provide.
   */
  readonly maxAggregateExposure?: FixedPointDecimal | undefined;

  /**
   * Maximum number of members in the composition. Checked at init.
   */
  readonly maxMemberCount?: number | undefined;

  /**
   * Minimum cash buffer as a fraction of total portfolio value that must
   * remain undeployed after rebalance (0 ≤ minCashBuffer < 1).
   */
  readonly minCashBuffer?: FixedPointDecimal | undefined;
}

// ---------------------------------------------------------------------------
// Violation types
// ---------------------------------------------------------------------------

export type ConstraintViolationKind =
  | "member-weight"
  | "aggregate-exposure"
  | "member-count"
  | "cash-buffer";

export interface MemberWeightViolation {
  readonly kind: "member-weight";
  readonly memberId: string;
  readonly actual: FixedPointDecimal;
  readonly limit: FixedPointDecimal;
}

export interface AggregateExposureViolation {
  readonly kind: "aggregate-exposure";
  readonly asset: AssetSymbol;
  readonly actual: FixedPointDecimal;
  readonly limit: FixedPointDecimal;
}

export interface MemberCountViolation {
  readonly kind: "member-count";
  readonly actual: number;
  readonly limit: number;
}

export interface CashBufferViolation {
  readonly kind: "cash-buffer";
  readonly actual: FixedPointDecimal;
  readonly limit: FixedPointDecimal;
}

export type ConstraintViolation =
  | MemberWeightViolation
  | AggregateExposureViolation
  | MemberCountViolation
  | CashBufferViolation;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CompositionConstraintErrorReason =
  | "invalid-max-member-weight"
  | "invalid-max-aggregate-exposure"
  | "invalid-max-member-count"
  | "invalid-min-cash-buffer"
  | "constraint-violated";

export class CompositionConstraintError extends Error {
  readonly reason: CompositionConstraintErrorReason;
  readonly violations: readonly ConstraintViolation[];

  constructor(
    reason: CompositionConstraintErrorReason,
    message: string,
    violations: readonly ConstraintViolation[] = []
  ) {
    super(message);
    this.name = "CompositionConstraintError";
    this.reason = reason;
    this.violations = violations;
  }
}

export function isCompositionConstraintError(
  error: unknown
): error is CompositionConstraintError {
  return error instanceof CompositionConstraintError;
}

// ---------------------------------------------------------------------------
// Portfolio view helpers
// ---------------------------------------------------------------------------

/** Per-member view needed for weight checking. */
export interface MemberView {
  readonly id: string;
  readonly portfolio: PortfolioView;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  /** All violations found. Empty when the composition is valid. */
  readonly violations: readonly ConstraintViolation[];
  /** True when `violations` is empty. */
  readonly valid: boolean;
}

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------

/**
 * Pure validator. Computes aggregate per-asset exposure across all members
 * and checks every enabled constraint. Returns every violation found; the
 * caller chooses the enforcement policy (reject or clamp).
 *
 * @param constraints  - The limits to enforce.
 * @param members      - Per-member portfolio views (must be non-empty).
 * @param portfolio    - The shared portfolio view (for cash and total value).
 * @param prices       - Current prices, used to compute portfolio value.
 * @throws {CompositionConstraintError} when a constraint definition is itself
 *   invalid (e.g. maxMemberWeight > 1).
 */
export function validateComposition(
  constraints: CompositionConstraints,
  members: readonly MemberView[],
  portfolio: PortfolioView,
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>
): ValidationResult {
  validateConstraintDefinitions(constraints);

  const violations: ConstraintViolation[] = [];
  const totalValue = portfolio.totalValue(prices);
  const totalStroops = totalValue.toStroops();

  // -- member-count -----------------------------------------------------------
  if (constraints.maxMemberCount !== undefined) {
    if (members.length > constraints.maxMemberCount) {
      violations.push({
        kind: "member-count",
        actual: members.length,
        limit: constraints.maxMemberCount,
      });
    }
  }

  // Early out when total value is zero: weight / exposure ratios are undefined.
  if (totalStroops <= 0n) {
    return { violations, valid: violations.length === 0 };
  }

  const one = FixedPointDecimal.fromStroops(10_000_000n); // 1.0

  // -- member-weight ----------------------------------------------------------
  if (constraints.maxMemberWeight !== undefined) {
    const limit = constraints.maxMemberWeight;
    for (const member of members) {
      const memberValue = member.portfolio.totalValue(prices);
      const weight = memberValue.div(totalValue);
      if (weight.compareTo(limit) > 0) {
        violations.push({
          kind: "member-weight",
          memberId: member.id,
          actual: weight,
          limit,
        });
      }
    }
  }

  // -- aggregate-exposure per asset -------------------------------------------
  if (constraints.maxAggregateExposure !== undefined) {
    const limit = constraints.maxAggregateExposure;

    // Collect all asset symbols across members.
    const assetSet = new Set<AssetSymbol>();
    for (const member of members) {
      for (const position of member.portfolio.positions()) {
        assetSet.add(position.asset);
      }
    }

    for (const asset of assetSet) {
      const price = prices.get(asset);
      if (price === undefined || price.toStroops() <= 0n) continue;

      // Sum the absolute notional across every member that holds this asset.
      let aggregateNotionalStroops = 0n;
      for (const member of members) {
        const position = member.portfolio.getPosition(asset);
        if (position === undefined) continue;
        const sizeStroops = position.size.toStroops();
        const abs = sizeStroops < 0n ? -sizeStroops : sizeStroops;
        // notional = |size| * price (both in stroops, result in stroops²/stroop = stroops)
        const notionalStroops =
          (abs * price.toStroops()) / 10_000_000n;
        aggregateNotionalStroops += notionalStroops;
      }

      const aggregateExposure = FixedPointDecimal.fromStroops(
        (aggregateNotionalStroops * 10_000_000n) / totalStroops
      );

      if (aggregateExposure.compareTo(limit) > 0) {
        violations.push({
          kind: "aggregate-exposure",
          asset,
          actual: aggregateExposure,
          limit,
        });
      }
    }
  }

  // -- cash-buffer ------------------------------------------------------------
  if (constraints.minCashBuffer !== undefined) {
    const limit = constraints.minCashBuffer;
    const cashBuffer = portfolio.cash.div(totalValue);
    if (cashBuffer.compareTo(limit) < 0) {
      violations.push({
        kind: "cash-buffer",
        actual: cashBuffer,
        limit,
      });
    }
  }

  return { violations, valid: violations.length === 0 };
}

// ---------------------------------------------------------------------------
// Enforcement policies
// ---------------------------------------------------------------------------

/**
 * Enforce constraints with the "reject" policy: throw a typed error listing
 * every violation when the composition is invalid.
 *
 * @throws {CompositionConstraintError} when any constraint is breached.
 */
export function enforceReject(result: ValidationResult): void {
  if (!result.valid) {
    const summary = result.violations
      .map((v) => describeViolation(v))
      .join("; ");
    throw new CompositionConstraintError(
      "constraint-violated",
      `Composition constraint violated: ${summary}`,
      result.violations
    );
  }
}

/**
 * Clamp result returned by `enforceClamp`.
 */
export interface ClampResult {
  /** Orders after clamping. Some sizes may have been reduced to zero. */
  readonly orders: readonly Order[];
  /** The violations that triggered clamping (empty when nothing was clamped). */
  readonly clampedViolations: readonly ConstraintViolation[];
}

/**
 * Enforce constraints with the "clamp" policy: reduce offending orders so
 * they no longer breach any aggregate-exposure limit, then return the trimmed
 * orders together with the violations that triggered clamping.
 *
 * Only `aggregate-exposure` violations are clamped directly on orders; the
 * other violation kinds (member-weight, member-count, cash-buffer) are
 * reported but do not alter orders because they cannot be corrected by trimming
 * a single order in isolation.
 *
 * @param result      - The validation result from `validateComposition`.
 * @param orders      - The orders to clamp.
 * @param prices      - Current prices used to scale order notionals.
 * @param totalValue  - Total portfolio value used to compute the limit notional.
 */
export function enforceClamp(
  result: ValidationResult,
  orders: readonly Order[],
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>,
  totalValue: FixedPointDecimal,
  constraints: CompositionConstraints
): ClampResult {
  if (result.valid) {
    return { orders: [...orders], clampedViolations: [] };
  }

  const clampedViolations: ConstraintViolation[] = [...result.violations];

  // Build a mutable copy of the orders indexed by asset.
  const mutableOrders: Order[] = orders.map((o) => ({ ...o }));

  // For each aggregate-exposure violation, scale down orders for that asset.
  const exposureViolations = result.violations.filter(
    (v): v is AggregateExposureViolation => v.kind === "aggregate-exposure"
  );

  for (const violation of exposureViolations) {
    const { asset, limit } = violation;
    const price = prices.get(asset);
    if (price === undefined || price.toStroops() <= 0n) continue;

    const totalValueStroops = totalValue.toStroops();
    if (totalValueStroops <= 0n) continue;

    // Maximum allowed absolute notional for this asset.
    const maxNotionalStroops =
      (limit.toStroops() * totalValueStroops) / 10_000_000n;

    // Current total absolute notional from the proposed orders.
    let currentNotionalStroops = 0n;
    for (const order of mutableOrders) {
      if (order.asset !== asset) continue;
      const sizeStroops = order.size.toStroops();
      const abs = sizeStroops < 0n ? -sizeStroops : sizeStroops;
      currentNotionalStroops += (abs * price.toStroops()) / 10_000_000n;
    }

    if (currentNotionalStroops === 0n) continue;

    // Scale factor to apply to every order for this asset.
    // scaleStroops = maxNotional / currentNotional (as a fixed-point fraction).
    const scaleStroops =
      (maxNotionalStroops * 10_000_000n) / currentNotionalStroops;

    for (let idx = 0; idx < mutableOrders.length; idx++) {
      const order = mutableOrders[idx]!;
      if (order.asset !== asset) continue;
      const sizeStroops = order.size.toStroops();
      const clampedStroops = (sizeStroops * scaleStroops) / 10_000_000n;
      mutableOrders[idx] = {
        ...order,
        size: FixedPointDecimal.fromStroops(clampedStroops),
      };
    }
  }

  return { orders: mutableOrders, clampedViolations };
}

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export type ConstraintEnforcementMode = "reject" | "clamp";

export interface CompositionConstraintConfig {
  readonly constraints: CompositionConstraints;
  /** Default: "reject". */
  readonly mode: ConstraintEnforcementMode;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function validateConstraintDefinitions(
  constraints: CompositionConstraints
): void {
  const one = FixedPointDecimal.fromStroops(10_000_000n);
  const zero = FixedPointDecimal.fromStroops(0n);

  if (constraints.maxMemberWeight !== undefined) {
    const v = constraints.maxMemberWeight;
    if (v.toStroops() <= 0n || v.compareTo(one) > 0) {
      throw new CompositionConstraintError(
        "invalid-max-member-weight",
        `maxMemberWeight must be in (0, 1], received ${v.toString()}`
      );
    }
  }

  if (constraints.maxAggregateExposure !== undefined) {
    const v = constraints.maxAggregateExposure;
    if (v.toStroops() <= 0n || v.compareTo(one) > 0) {
      throw new CompositionConstraintError(
        "invalid-max-aggregate-exposure",
        `maxAggregateExposure must be in (0, 1], received ${v.toString()}`
      );
    }
  }

  if (constraints.maxMemberCount !== undefined) {
    if (!Number.isInteger(constraints.maxMemberCount) || constraints.maxMemberCount < 1) {
      throw new CompositionConstraintError(
        "invalid-max-member-count",
        `maxMemberCount must be a positive integer, received ${constraints.maxMemberCount}`
      );
    }
  }

  if (constraints.minCashBuffer !== undefined) {
    const v = constraints.minCashBuffer;
    if (v.toStroops() < 0n || v.compareTo(one) >= 0) {
      throw new CompositionConstraintError(
        "invalid-min-cash-buffer",
        `minCashBuffer must be in [0, 1), received ${v.toString()}`
      );
    }
  }
}

function describeViolation(violation: ConstraintViolation): string {
  switch (violation.kind) {
    case "member-weight":
      return `member "${violation.memberId}" weight ${violation.actual.toString()} exceeds limit ${violation.limit.toString()}`;
    case "aggregate-exposure":
      return `asset "${violation.asset}" aggregate exposure ${violation.actual.toString()} exceeds limit ${violation.limit.toString()}`;
    case "member-count":
      return `member count ${violation.actual} exceeds limit ${violation.limit}`;
    case "cash-buffer":
      return `cash buffer ${violation.actual.toString()} is below minimum ${violation.limit.toString()}`;
  }
}
