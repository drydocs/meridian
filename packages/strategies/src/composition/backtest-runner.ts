import type { BacktestConfig, BacktestResult } from "../backtest";
import { runBacktest } from "../backtest";
import { FixedPointDecimal, STROOPS_PER_UNIT } from "../types";
import type { SimulationTimestamp } from "../types";
import type { Position, PriceSet } from "../portfolio";
import { allocateCapital } from "./capital-allocation";
import type { ComposedStrategy } from "./index";

const ZERO = FixedPointDecimal.fromStroops(0n);

export interface ComposedAttributionSnapshot {
  readonly index: number;
  readonly timestamp: SimulationTimestamp;
  readonly value: FixedPointDecimal;
  readonly pnl: FixedPointDecimal;
}

export interface ComposedMemberAttribution {
  readonly id: string;
  readonly initialCapital: FixedPointDecimal;
  readonly snapshots: readonly ComposedAttributionSnapshot[];
  readonly finalValue: FixedPointDecimal;
  readonly pnlContribution: FixedPointDecimal;
  readonly totalFees: FixedPointDecimal;
}

export interface ComposedAttribution {
  readonly members: readonly ComposedMemberAttribution[];
  readonly totalPnl: FixedPointDecimal;
  readonly totalFees: FixedPointDecimal;
}

export interface ComposedBacktestResult extends BacktestResult {
  readonly attribution: ComposedAttribution;
}

export type ComposedBacktestConfig = Omit<
  BacktestConfig<unknown>,
  "strategy" | "strategyConfig" | "observer"
> & { readonly strategy: ComposedStrategy };

interface MemberLedger {
  readonly id: string;
  readonly initialCapital: FixedPointDecimal;
  readonly snapshots: ComposedAttributionSnapshot[];
  cash: FixedPointDecimal;
  fees: FixedPointDecimal;
  finalValue?: FixedPointDecimal;
}

/** Runs a composition through the standard runner and attributes its ledger. */
export function runComposedBacktest(
  config: ComposedBacktestConfig
): ComposedBacktestResult {
  const { strategy, ...backtestConfig } = config;
  const initialCapital = allocateInitialCapital(
    config.initialCash,
    strategy.memberAllocations
  );
  const members: MemberLedger[] = strategy.memberAllocations.map(({ id }) => {
    const capital = initialCapital.get(id);
    if (capital === undefined) {
      throw new Error(`missing initial capital for composition member "${id}"`);
    }
    return {
      id,
      initialCapital: capital,
      snapshots: [],
      cash: capital,
      fees: ZERO,
    };
  });

  const ownerFor = (namespace: string | undefined): MemberLedger => {
    const owner = members.find(
      (member) =>
        namespace === member.id || namespace?.startsWith(`${member.id}/`)
    );
    if (owner === undefined) {
      throw new Error(
        `composed backtest event has no owning member for "${namespace ?? ""}"`
      );
    }
    return owner;
  };

  const aggregate = runBacktest({
    ...backtestConfig,
    strategy,
    strategyConfig: undefined,
    observer: {
      onAccrual: ({ cashBefore, transactions }) => {
        let cashInterest = ZERO;
        const fundingFlows: Array<{
          readonly member: MemberLedger;
          readonly amount: FixedPointDecimal;
        }> = [];
        for (const transaction of transactions) {
          if (transaction.type === "cash-interest") {
            cashInterest = cashInterest.add(transaction.amount);
          } else if (transaction.type === "funding-payment") {
            fundingFlows.push({
              member: ownerFor(transaction.memberId),
              amount: transaction.amount,
            });
          }
        }
        applyCashInterest(members, cashInterest, cashBefore);
        for (const flow of fundingFlows) {
          flow.member.cash = flow.member.cash.add(flow.amount);
        }
      },
      onFill: ({ memberId, size, price, fee }) => {
        const owner = ownerFor(memberId);
        owner.cash = owner.cash.sub(size.mul(price)).sub(fee);
        owner.fees = owner.fees.add(fee);
      },
      onSnapshot: (snapshot, prices) => {
        const values = memberValues(members, snapshot.positions, prices);
        assertReconciles(values, snapshot.value, `snapshot ${snapshot.index}`);
        for (const member of members) {
          const value = values.get(member.id)!;
          member.snapshots.push({
            index: snapshot.index,
            timestamp: snapshot.timestamp,
            value,
            pnl: value.sub(member.initialCapital),
          });
        }
      },
      onFinal: ({ positions, prices }) => {
        const values = memberValues(members, positions, prices);
        for (const member of members) {
          member.finalValue = values.get(member.id)!;
        }
      },
    },
  });

  const attributionMembers = members.map((member) => {
    const finalValue = member.finalValue;
    if (finalValue === undefined) {
      throw new Error(
        `missing final value for composition member "${member.id}"`
      );
    }
    return {
      id: member.id,
      initialCapital: member.initialCapital,
      snapshots: member.snapshots,
      finalValue,
      pnlContribution: finalValue.sub(member.initialCapital),
      totalFees: member.fees,
    };
  });
  const totalPnl = aggregate.finalValue.sub(aggregate.initialCash);
  assertReconciles(
    new Map(
      attributionMembers.map(({ id, pnlContribution }) => [id, pnlContribution])
    ),
    totalPnl,
    "final PnL"
  );
  assertReconciles(
    new Map(attributionMembers.map(({ id, totalFees }) => [id, totalFees])),
    aggregate.totalFees,
    "total fees"
  );

  return {
    ...aggregate,
    attribution: {
      members: attributionMembers,
      totalPnl,
      totalFees: aggregate.totalFees,
    },
  };
}

/** Canonical, byte-stable JSON for a composed attribution. */
export function serializeComposedAttribution(
  attribution: ComposedAttribution
): string {
  return JSON.stringify({
    totalPnl: attribution.totalPnl.toString(),
    totalFees: attribution.totalFees.toString(),
    members: attribution.members.map((member) => ({
      id: member.id,
      initialCapital: member.initialCapital.toString(),
      snapshots: member.snapshots.map((snapshot) => ({
        index: snapshot.index,
        timestamp: snapshot.timestamp,
        value: snapshot.value.toString(),
        pnl: snapshot.pnl.toString(),
      })),
      finalValue: member.finalValue.toString(),
      pnlContribution: member.pnlContribution.toString(),
      totalFees: member.totalFees.toString(),
    })),
  });
}

/** Restores decimals from {@link serializeComposedAttribution}'s JSON. */
export function deserializeComposedAttribution(
  serialized: string
): ComposedAttribution {
  const parsed = JSON.parse(serialized) as {
    totalPnl: string;
    totalFees: string;
    members: Array<{
      id: string;
      initialCapital: string;
      snapshots: Array<{
        index: number;
        timestamp: number;
        value: string;
        pnl: string;
      }>;
      finalValue: string;
      pnlContribution: string;
      totalFees: string;
    }>;
  };
  return {
    totalPnl: FixedPointDecimal.fromString(parsed.totalPnl),
    totalFees: FixedPointDecimal.fromString(parsed.totalFees),
    members: parsed.members.map((member) => ({
      id: member.id,
      initialCapital: FixedPointDecimal.fromString(member.initialCapital),
      snapshots: member.snapshots.map((snapshot) => ({
        index: snapshot.index,
        timestamp: snapshot.timestamp,
        value: FixedPointDecimal.fromString(snapshot.value),
        pnl: FixedPointDecimal.fromString(snapshot.pnl),
      })),
      finalValue: FixedPointDecimal.fromString(member.finalValue),
      pnlContribution: FixedPointDecimal.fromString(member.pnlContribution),
      totalFees: FixedPointDecimal.fromString(member.totalFees),
    })),
  };
}

function allocateInitialCapital(
  total: FixedPointDecimal,
  members: ComposedStrategy["memberAllocations"]
): ReadonlyMap<string, FixedPointDecimal> {
  const totalStroops = total.toStroops();
  const sign = totalStroops < 0n ? -1n : 1n;
  const allocations = allocateCapital(
    FixedPointDecimal.fromStroops(totalStroops * sign),
    members.map(({ id, allocation }) => ({ id, weight: allocation }))
  );
  return new Map(
    allocations.map(({ id, amount }) => [
      id,
      FixedPointDecimal.fromStroops(amount.toStroops() * sign),
    ])
  );
}

function applyCashInterest(
  members: readonly MemberLedger[],
  amount: FixedPointDecimal,
  cashBefore: FixedPointDecimal
): void {
  if (amount.toStroops() === 0n) return;
  const totalCash = cashBefore.toStroops();
  if (totalCash === 0n) {
    throw new Error(
      "cash interest cannot be attributed with zero aggregate cash"
    );
  }

  let assigned = 0n;
  const shares = members.map((member) => {
    const share = (amount.toStroops() * member.cash.toStroops()) / totalCash;
    assigned += share;
    return share;
  });
  shares[0] = shares[0]! + amount.toStroops() - assigned;
  members.forEach((member, index) => {
    member.cash = member.cash.add(
      FixedPointDecimal.fromStroops(shares[index]!)
    );
  });
}

function memberValues(
  members: readonly MemberLedger[],
  positions: readonly Position[],
  prices: PriceSet
): ReadonlyMap<string, FixedPointDecimal> {
  const values = new Map(members.map((member) => [member.id, member.cash]));
  for (const position of positions) {
    const owner = members.find(
      (member) =>
        position.memberId === member.id ||
        position.memberId?.startsWith(`${member.id}/`)
    );
    if (owner === undefined) {
      throw new Error(
        `composed backtest position has no owning member for "${position.memberId ?? ""}"`
      );
    }
    const price = prices.get(position.asset);
    if (price === undefined) {
      throw new RangeError(`no price for attributed asset "${position.asset}"`);
    }
    const positionValue = FixedPointDecimal.fromStroops(
      (position.size.toStroops() * price.toStroops()) / STROOPS_PER_UNIT
    );
    values.set(owner.id, values.get(owner.id)!.add(positionValue));
  }
  return values;
}

function assertReconciles(
  values: ReadonlyMap<string, FixedPointDecimal>,
  expected: FixedPointDecimal,
  label: string
): void {
  const actual = [...values.values()].reduce(
    (sum, value) => sum.add(value),
    ZERO
  );
  if (actual.toStroops() !== expected.toStroops()) {
    throw new Error(
      `${label} attribution does not reconcile: ${actual.toString()} != ${expected.toString()}`
    );
  }
}
