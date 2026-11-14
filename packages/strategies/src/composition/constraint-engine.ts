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
 * The validator evaluates the post-trade composition: current positions plus
 * any proposed orders at the current marks. Members never mutate one another's
 * orders; the composition applies the policy when merging member orders.
 */
import { FixedPointDecimal, UnknownAssetError } from "../types";
import type { AssetSymbol } from "../types";
import type { Order, PortfolioView } from "../strategy";

const UNIT = 10_000_000n;

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Declarative limits on a composition. All fields are optional; supply only
 * the constraints that matter for your composition.
 */
export interface CompositionConstraints {
  /**
   * Maximum fraction of total portfolio value held as one member's gross
   * position exposure (0 < maxMemberWeight ≤ 1). Checked after rebalance.
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
  "member-weight" | "aggregate-exposure" | "member-count" | "cash-buffer";

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
 * Pure validator. Computes post-trade gross exposure across members and checks
 * every enabled constraint. Returns every violation found; the caller chooses
 * the enforcement policy (reject or clamp).
 *
 * @param constraints   - The limits to enforce.
 * @param members       - Per-member portfolio views (must be non-empty).
 * @param portfolio     - The shared portfolio view (for cash and total value).
 * @param prices        - Current prices, used to compute portfolio value.
 * @param proposedOrders - Orders that have not been applied yet.
 * @throws {CompositionConstraintError} when a constraint definition is itself
 *   invalid (e.g. maxMemberWeight > 1).
 * @throws {UnknownAssetError} when a held or ordered asset has no price.
 */
export function validateComposition(
  constraints: CompositionConstraints,
  members: readonly MemberView[],
  portfolio: PortfolioView,
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>,
  proposedOrders: readonly Order[] = []
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

  // -- member-weight ----------------------------------------------------------
  if (constraints.maxMemberWeight !== undefined) {
    const limit = constraints.maxMemberWeight;
    for (const member of members) {
      const memberValue = grossMemberValue(
        member,
        portfolio,
        proposedOrders,
        prices
      );
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
    const exposures = aggregateExposures(portfolio, proposedOrders, prices);

    for (const [asset, exposure] of exposures) {
      if (exposure.compareTo(limit) > 0) {
        violations.push({
          kind: "aggregate-exposure",
          asset,
          actual: exposure,
          limit,
        });
      }
    }
  }

  // -- cash-buffer ------------------------------------------------------------
  if (constraints.minCashBuffer !== undefined) {
    const limit = constraints.minCashBuffer;
    const cashBuffer = projectedCash(portfolio, proposedOrders, prices).div(
      totalValue
    );
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
 * Enforce constraints with the "clamp" policy: reduce offending orders so the
 * post-trade composition no longer breaches an aggregate-exposure limit, then
 * return the trimmed orders together with the violations that were clamped.
 *
 * Only `aggregate-exposure` violations can be clamped. Member-count,
 * member-weight and cash-buffer violations are rejected because trimming
 * orders cannot guarantee those limits are met.
 *
 * @param result      - The validation result from `validateComposition`.
 * @param orders      - The orders to clamp.
 * @param prices      - Current prices used to scale order notionals.
 * @param totalValue  - Total portfolio value used to compute the limit notional.
 * @param portfolio   - Current portfolio state, used to measure existing exposure.
 * @throws {CompositionConstraintError} when current exposure already breaches
 *   the limit or a violation cannot be fixed by trimming orders.
 */
export function enforceClamp(
  result: ValidationResult,
  orders: readonly Order[],
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>,
  totalValue: FixedPointDecimal,
  portfolio: PortfolioView
): ClampResult {
  if (result.valid) {
    return { orders: [...orders], clampedViolations: [] };
  }

  const totalStroops = totalValue.toStroops();
  if (totalStroops <= 0n) {
    throw new CompositionConstraintError(
      "constraint-violated",
      "cannot clamp a composition with non-positive total value",
      result.violations
    );
  }

  const clampedViolations: AggregateExposureViolation[] = [];
  const mutableOrders: Order[] = orders.map((order) => ({ ...order }));

  for (const violation of result.violations) {
    if (violation.kind !== "aggregate-exposure") {
      throw new CompositionConstraintError(
        "constraint-violated",
        `cannot clamp ${violation.kind} violation by trimming orders: ${describeViolation(violation)}`,
        [violation]
      );
    }

    const price = requirePrice(prices, violation.asset);
    const targetStroops = (violation.limit.toStroops() * totalStroops) / UNIT;
    const currentStroops = currentAssetExposureStroops(
      portfolio,
      violation.asset,
      price.toStroops()
    );

    if (currentStroops >= targetStroops) {
      throw new CompositionConstraintError(
        "constraint-violated",
        `cannot clamp ${violation.asset} exposure because current exposure already breaches the limit: ${describeViolation(violation)}`,
        [violation]
      );
    }

    const availableStroops = targetStroops - currentStroops;
    const increasing: Array<{
      readonly index: number;
      readonly currentSize: bigint;
      readonly increase: bigint;
    }> = [];

    let increasingStroops = 0n;
    for (let index = 0; index < mutableOrders.length; index += 1) {
      const order = mutableOrders[index]!;
      if (order.asset !== violation.asset) continue;

      const currentSize = currentMemberSize(
        portfolio,
        order.memberId,
        order.asset
      );
      const orderSize = order.size.toStroops();
      const currentAbs = absStroops(currentSize);
      const newAbs = absStroops(currentSize + orderSize);
      if (newAbs <= currentAbs) continue;

      const increase = newAbs - currentAbs;
      increasing.push({ index, currentSize, increase });
      increasingStroops += (increase * price.toStroops()) / UNIT;
    }

    if (increasingStroops <= availableStroops) continue;

    const scaleStroops = (availableStroops * UNIT) / increasingStroops;
    for (const { index, currentSize, increase } of increasing) {
      const order = mutableOrders[index]!;
      const clampedIncrease = (increase * scaleStroops) / UNIT;
      const currentAbs = absStroops(currentSize);
      const clampedAbs = currentAbs + clampedIncrease;
      const clampedSize =
        currentSize === 0n
          ? order.size.toStroops() < 0n
            ? -clampedAbs
            : clampedAbs
          : currentSize < 0n
            ? -clampedAbs
            : clampedAbs;

      mutableOrders[index] = {
        ...order,
        size: FixedPointDecimal.fromStroops(clampedSize - currentSize),
      };
    }

    clampedViolations.push(violation);
  }

  return { orders: mutableOrders, clampedViolations };
}

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export type ConstraintEnforcementMode = "reject" | "clamp";

export interface CompositionConstraintConfig {
  readonly constraints: CompositionConstraints;
  /** Defaults to "reject". */
  readonly mode?: ConstraintEnforcementMode | undefined;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Throws when a constraint definition itself is invalid. Exported so callers
 * that validate a composition before any positions exist (for example at
 * strategy init) can still reject malformed limits.
 */
export function validateConstraintDefinitions(
  constraints: CompositionConstraints
): void {
  const one = FixedPointDecimal.fromStroops(UNIT);

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
    if (
      !Number.isInteger(constraints.maxMemberCount) ||
      constraints.maxMemberCount < 1
    ) {
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

function absStroops(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function notionalStroops(size: bigint, price: bigint): bigint {
  return (absStroops(size) * price) / UNIT;
}

function requirePrice(
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>,
  asset: AssetSymbol
): FixedPointDecimal {
  const price = prices.get(asset);
  if (price === undefined) throw new UnknownAssetError(asset);
  if (price.toStroops() <= 0n) {
    throw new RangeError(`price for ${asset} must be positive`);
  }
  return price;
}

function ownsMember(ownerId: string, memberId: string | undefined): boolean {
  return (
    memberId === ownerId ||
    (memberId !== undefined && memberId.startsWith(`${ownerId}/`))
  );
}

function ownsNestedMember(
  ownerId: string,
  memberId: string | undefined
): boolean {
  return (
    memberId !== undefined &&
    memberId !== ownerId &&
    memberId.startsWith(`${ownerId}/`)
  );
}

function addSize(
  sizes: Map<AssetSymbol, bigint>,
  asset: AssetSymbol,
  size: bigint
): void {
  sizes.set(asset, (sizes.get(asset) ?? 0n) + size);
}

function grossMemberValue(
  member: MemberView,
  portfolio: PortfolioView,
  proposedOrders: readonly Order[],
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>
): FixedPointDecimal {
  const sizes = new Map<AssetSymbol, bigint>();
  for (const position of member.portfolio.positions()) {
    addSize(sizes, position.asset, position.size.toStroops());
  }
  for (const position of portfolio.positions()) {
    if (!ownsNestedMember(member.id, position.memberId)) continue;
    addSize(sizes, position.asset, position.size.toStroops());
  }
  for (const order of proposedOrders) {
    if (!ownsMember(member.id, order.memberId)) continue;
    addSize(sizes, order.asset, order.size.toStroops());
  }

  let total = 0n;
  for (const [asset, size] of sizes) {
    if (size === 0n) continue;
    total += notionalStroops(size, requirePrice(prices, asset).toStroops());
  }
  return FixedPointDecimal.fromStroops(total);
}

function aggregateExposures(
  portfolio: PortfolioView,
  proposedOrders: readonly Order[],
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>
): ReadonlyMap<AssetSymbol, FixedPointDecimal> {
  const sizes = new Map<AssetSymbol, bigint>();
  for (const position of portfolio.positions()) {
    sizes.set(
      position.asset,
      (sizes.get(position.asset) ?? 0n) + position.size.toStroops()
    );
  }
  for (const order of proposedOrders) {
    sizes.set(
      order.asset,
      (sizes.get(order.asset) ?? 0n) + order.size.toStroops()
    );
  }

  const totalStroops = portfolio.totalValue(prices).toStroops();
  const exposures = new Map<AssetSymbol, FixedPointDecimal>();
  for (const [asset, size] of sizes) {
    if (size === 0n) continue;
    const price = requirePrice(prices, asset);
    const notional = notionalStroops(size, price.toStroops());
    exposures.set(
      asset,
      FixedPointDecimal.fromStroops((notional * UNIT) / totalStroops)
    );
  }
  return exposures;
}

function projectedCash(
  portfolio: PortfolioView,
  proposedOrders: readonly Order[],
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>
): FixedPointDecimal {
  let cash = portfolio.cash;
  for (const order of proposedOrders) {
    const price = requirePrice(prices, order.asset);
    cash = cash.sub(order.size.mul(price));
  }
  return cash;
}

function currentAssetExposureStroops(
  portfolio: PortfolioView,
  asset: AssetSymbol,
  price: bigint
): bigint {
  let total = 0n;
  for (const position of portfolio.positions()) {
    if (position.asset !== asset) continue;
    total += notionalStroops(position.size.toStroops(), price);
  }
  return total;
}

function currentMemberSize(
  portfolio: PortfolioView,
  memberId: string | undefined,
  asset: AssetSymbol
): bigint {
  const position = portfolio
    .positions()
    .find(
      (candidate) =>
        candidate.asset === asset && candidate.memberId === memberId
    );
  return position?.size.toStroops() ?? 0n;
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
