/**
 * Target-weight drift rebalancing for composed strategies.
 *
 * A `ComposedStrategy` assigns each member a target weight (`allocation`),
 * which initially splits starting capital. Over time, member returns diverge
 * and actual member values drift away from their target weights. This module
 * evaluates member weight drift against a threshold policy, a calendar policy,
 * or both, and generates cash-neutral cross-member transfer orders to restore
 * target weights.
 *
 * ## Tie-breaking
 *
 * When multiple members drift at the same time, order generation is fully
 * deterministic:
 *
 * 1. **Sells before buys**: overweight members (`actualWeight > targetWeight`)
 *    are emitted before underweight members (`actualWeight < targetWeight`) so
 *    capital is freed before it is redeployed.
 * 2. **Largest drift first**: within the overweight group and within the
 *    underweight group, members are sorted by descending absolute weight drift
 *    (`|actualWeight - targetWeight|`).
 * 3. **Declaration-order tie-breaker**: when two or more members have the exact
 *    same absolute drift, ties are broken by member declaration order (the
 *    order in which members were passed to `ComposedStrategy`).
 * 4. **Lexicographic asset order**: when a member holds multiple assets, its
 *    rebalance notional is distributed proportionally across its held assets in
 *    lexicographic `AssetSymbol` order.
 */
import {
  FixedPointDecimal,
  STROOPS_PER_UNIT,
  UnknownAssetError,
} from "../types";
import type { AssetSymbol, SimulationTimestamp } from "../types";
import type { Order, PortfolioView } from "../strategy";

const UNIT = STROOPS_PER_UNIT;

/**
 * Policy configuration for target-weight drift rebalancing.
 *
 * At least one of `threshold` or `calendarIntervalMs` must be provided.
 * When both are provided, rebalancing triggers whenever either condition is
 * met (threshold breached OR calendar interval elapsed).
 */
export interface DriftRebalanceConfig {
  /**
   * Maximum allowed absolute weight drift for any member, expressed as a
   * fraction in `[0, 1]` (e.g. `0.05` for 5%). Rebalancing triggers when at
   * least one member's `|actualWeight - targetWeight|` is strictly greater
   * than `threshold`.
   */
  readonly threshold?: FixedPointDecimal | undefined;

  /**
   * Minimum elapsed simulation time in milliseconds between calendar-driven
   * rebalances. Must be a positive integer. Rebalancing triggers when
   * `timestamp - lastRebalanceTimestamp >= calendarIntervalMs`.
   */
  readonly calendarIntervalMs?: number | undefined;
}

/** Target weight for one member in declaration order. */
export interface MemberWeightTarget {
  readonly id: string;
  readonly targetWeight: FixedPointDecimal;
}

/** Drift measurement for one member at the current tick. */
export interface MemberDrift {
  readonly id: string;
  readonly actualValue: FixedPointDecimal;
  readonly targetValue: FixedPointDecimal;
  readonly actualWeight: FixedPointDecimal;
  readonly targetWeight: FixedPointDecimal;
  /** Signed weight drift: `actualWeight - targetWeight`. */
  readonly drift: FixedPointDecimal;
}

export type DriftTriggerReason = "none" | "threshold" | "calendar" | "both";

/** Result of evaluating drift and generating cross-member transfer orders. */
export interface DriftRebalanceResult {
  readonly triggered: boolean;
  readonly triggerReason: DriftTriggerReason;
  readonly drifts: readonly MemberDrift[];
  readonly orders: readonly Order[];
}

/**
 * Validates a `DriftRebalanceConfig`.
 *
 * @throws {RangeError} when neither policy is configured or a parameter is
 *   out of range.
 */
export function validateDriftRebalanceConfig(
  config: DriftRebalanceConfig
): void {
  if (
    config.threshold === undefined &&
    config.calendarIntervalMs === undefined
  ) {
    throw new RangeError(
      "drift rebalance config requires at least one of threshold or calendarIntervalMs"
    );
  }

  if (config.threshold !== undefined) {
    const stroops = config.threshold.toStroops();
    if (stroops < 0n || stroops > UNIT) {
      throw new RangeError(
        `drift threshold must be in [0, 1], received ${config.threshold.toString()}`
      );
    }
  }

  if (config.calendarIntervalMs !== undefined) {
    if (
      !Number.isInteger(config.calendarIntervalMs) ||
      config.calendarIntervalMs <= 0
    ) {
      throw new RangeError(
        `calendarIntervalMs must be a positive integer, received ${config.calendarIntervalMs}`
      );
    }
  }
}

interface AssetHolding {
  readonly asset: AssetSymbol;
  readonly size: bigint;
  readonly price: bigint;
  readonly value: bigint;
}

interface MemberSnapshot {
  readonly id: string;
  readonly declarationIndex: number;
  readonly targetWeight: bigint;
  readonly actualValue: bigint;
  readonly targetValue: bigint;
  readonly actualWeight: bigint;
  readonly drift: bigint;
  readonly absDrift: bigint;
  readonly holdings: readonly AssetHolding[];
}

/**
 * Evaluates member weight drift against `config` and generates cross-member
 * transfer orders when triggered.
 *
 * Member values are measured after applying `proposedOrders` (the member
 * orders already emitted on this tick) at `prices`. Weights are computed
 * relative to total deployed member value so rebalancing transfers value
 * between overweight and underweight members without draining the shared cash
 * buffer.
 *
 * @throws {RangeError} when rebalancing is triggered and an underweight member
 *   holds no open positions (so there is no held asset to fund without
 *   guessing the member's asset selection).
 */
export function computeDriftRebalance(
  config: DriftRebalanceConfig,
  members: readonly MemberWeightTarget[],
  portfolio: PortfolioView,
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>,
  proposedOrders: readonly Order[],
  timestamp: SimulationTimestamp,
  lastRebalanceTimestamp: SimulationTimestamp | null
): DriftRebalanceResult {
  validateDriftRebalanceConfig(config);

  const holdingsByMember: AssetHolding[][] = [];
  const memberValues: bigint[] = [];
  let totalMemberValue = 0n;

  for (const member of members) {
    const sizes = new Map<AssetSymbol, bigint>();
    for (const position of portfolio.positions()) {
      if (!ownsMember(member.id, position.memberId)) continue;
      sizes.set(
        position.asset,
        (sizes.get(position.asset) ?? 0n) + position.size.toStroops()
      );
    }
    for (const order of proposedOrders) {
      if (!ownsMember(member.id, order.memberId)) continue;
      sizes.set(
        order.asset,
        (sizes.get(order.asset) ?? 0n) + order.size.toStroops()
      );
    }

    const holdings: AssetHolding[] = [];
    let memberValue = 0n;
    const sortedAssets = [...sizes.keys()].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const asset of sortedAssets) {
      const size = sizes.get(asset)!;
      if (size === 0n) continue;
      const price = requirePrice(prices, asset).toStroops();
      const value = (absStroops(size) * price) / UNIT;
      holdings.push({ asset, size, price, value });
      memberValue += value;
    }

    holdingsByMember.push(holdings);
    memberValues.push(memberValue);
    totalMemberValue += memberValue;
  }

  if (totalMemberValue <= 0n) {
    const zero = FixedPointDecimal.fromStroops(0n);
    return {
      triggered: false,
      triggerReason: "none",
      drifts: members.map((member) => ({
        id: member.id,
        actualValue: zero,
        targetValue: zero,
        actualWeight: zero,
        targetWeight: member.targetWeight,
        drift: FixedPointDecimal.fromStroops(-member.targetWeight.toStroops()),
      })),
      orders: [],
    };
  }

  const snapshots: MemberSnapshot[] = members.map((member, index) => {
    const targetWeight = member.targetWeight.toStroops();
    const actualValue = memberValues[index]!;
    const targetValue = (totalMemberValue * targetWeight) / UNIT;
    const actualWeight = (actualValue * UNIT) / totalMemberValue;
    const drift = actualWeight - targetWeight;
    return {
      id: member.id,
      declarationIndex: index,
      targetWeight,
      actualValue,
      targetValue,
      actualWeight,
      drift,
      absDrift: absStroops(drift),
      holdings: holdingsByMember[index]!,
    };
  });

  const drifts: MemberDrift[] = snapshots.map((s) => ({
    id: s.id,
    actualValue: FixedPointDecimal.fromStroops(s.actualValue),
    targetValue: FixedPointDecimal.fromStroops(s.targetValue),
    actualWeight: FixedPointDecimal.fromStroops(s.actualWeight),
    targetWeight: FixedPointDecimal.fromStroops(s.targetWeight),
    drift: FixedPointDecimal.fromStroops(s.drift),
  }));

  const thresholdTriggered =
    config.threshold !== undefined &&
    snapshots.some((s) => s.absDrift > config.threshold!.toStroops());

  const calendarTriggered =
    config.calendarIntervalMs !== undefined &&
    lastRebalanceTimestamp !== null &&
    timestamp - lastRebalanceTimestamp >= config.calendarIntervalMs;

  const triggerReason: DriftTriggerReason =
    thresholdTriggered && calendarTriggered
      ? "both"
      : thresholdTriggered
        ? "threshold"
        : calendarTriggered
          ? "calendar"
          : "none";

  if (triggerReason === "none") {
    return { triggered: false, triggerReason, drifts, orders: [] };
  }

  const unfunded = snapshots.find(
    (s) => s.actualValue < s.targetValue && s.holdings.length === 0
  );
  if (unfunded !== undefined) {
    throw new RangeError(
      `cannot fund underweight member "${unfunded.id}" with no open positions`
    );
  }

  const overweight = snapshots
    .filter((s) => s.actualValue > s.targetValue && s.holdings.length > 0)
    .sort(compareByDriftThenDeclaration);

  const underweight = snapshots
    .filter((s) => s.actualValue < s.targetValue)
    .sort(compareByDriftThenDeclaration);

  const totalExcess = overweight.reduce(
    (sum, s) => sum + (s.actualValue - s.targetValue),
    0n
  );
  const totalDeficit = underweight.reduce(
    (sum, s) => sum + (s.targetValue - s.actualValue),
    0n
  );
  const transferable = totalExcess < totalDeficit ? totalExcess : totalDeficit;

  if (transferable <= 0n) {
    return { triggered: true, triggerReason, drifts, orders: [] };
  }

  const orders: Order[] = [];

  // 1. Overweight members reduce positions (sells before buys).
  for (const member of overweight) {
    const excess = member.actualValue - member.targetValue;
    const sellNotional = (excess * transferable) / totalExcess;
    appendProportionalOrders(orders, member, sellNotional, "reduce");
  }

  // 2. Underweight members increase positions.
  for (const member of underweight) {
    const deficit = member.targetValue - member.actualValue;
    const buyNotional = (deficit * transferable) / totalDeficit;
    appendProportionalOrders(orders, member, buyNotional, "increase");
  }

  return { triggered: true, triggerReason, drifts, orders };
}

function compareByDriftThenDeclaration(
  a: MemberSnapshot,
  b: MemberSnapshot
): number {
  if (a.absDrift !== b.absDrift) {
    return b.absDrift > a.absDrift ? 1 : -1;
  }
  return a.declarationIndex - b.declarationIndex;
}

function appendProportionalOrders(
  orders: Order[],
  member: MemberSnapshot,
  notional: bigint,
  direction: "reduce" | "increase"
): void {
  if (notional <= 0n || member.actualValue <= 0n) return;

  for (const holding of member.holdings) {
    const assetNotional = (notional * holding.value) / member.actualValue;
    const deltaAbsSize = (assetNotional * UNIT) / holding.price;
    if (deltaAbsSize === 0n) continue;

    const isLong = holding.size > 0n;
    const signedSize =
      direction === "reduce"
        ? isLong
          ? -deltaAbsSize
          : deltaAbsSize
        : isLong
          ? deltaAbsSize
          : -deltaAbsSize;

    orders.push({
      asset: holding.asset,
      size: FixedPointDecimal.fromStroops(signedSize),
      memberId: member.id,
      reason: "drift-rebalance",
    });
  }
}

function absStroops(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function ownsMember(ownerId: string, memberId: string | undefined): boolean {
  return (
    memberId === ownerId ||
    (memberId !== undefined && memberId.startsWith(`${ownerId}/`))
  );
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
