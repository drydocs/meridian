import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClock } from "./clock";
import type { SimulationClock } from "./clock";
import { formatFixed, parseFixed, whole } from "./decimal";
import type { Fixed } from "./decimal";
import { runBacktest, serializeSnapshots } from "./runner";
import type { BacktestResult } from "./runner";
import type { Order, Strategy, StrategyContext } from "./strategy";

const X = "XLM";
const ZERO_COST = { slippageBps: 0n, feeBps: 0n } as const;
const NO_ACCRUAL = { cashRate: 0n, fundingRate: 0n } as const;

function clockFrom(prices: readonly number[]): SimulationClock {
  return createClock({
    startTime: 0,
    stepMs: 60_000,
    pricePath: prices.map((price) => ({ [X]: whole(BigInt(price)) })),
  });
}

/** Buys `quantity` on one tick, then holds. Records its own lifecycle. */
function buyAndHold(asset: string, quantity: Fixed, atTick = 0) {
  const ticks: number[] = [];
  let closedAt: number | null = null;
  const strategy: Strategy = {
    id: "buy-and-hold",
    onTick(context: StrategyContext): readonly Order[] {
      ticks.push(context.tick.index);
      if (context.tick.index !== atTick) return [];
      return [{ asset, side: "buy", quantity }];
    },
    onClose(context: StrategyContext): void {
      closedAt = context.tick.index;
    },
  };
  return { strategy, ticks, closedAt: () => closedAt };
}

describe("runBacktest", () => {
  it("reproduces a hand-worked buy-and-hold final value", () => {
    const { strategy, ticks, closedAt } = buyAndHold(X, whole(10n));
    const result = runBacktest({
      clock: clockFrom([100, 110, 121]),
      strategy,
      initialCash: whole(1000n),
      execution: ZERO_COST,
      accrual: NO_ACCRUAL,
    });

    // Lifecycle: one onTick per clock tick, in order, then onClose at the end.
    expect(ticks).toEqual([0, 1, 2]);
    expect(closedAt()).toBe(2);

    // Hand-worked: 1000 cash buys 10 units at 100; 10 * 121 = 1210.
    expect(result.snapshots.map((s) => formatFixed(s.value))).toEqual([
      "1000",
      "1100",
      "1210",
    ]);
    expect(result.snapshots.map((s) => formatFixed(s.cash))).toEqual([
      "0",
      "0",
      "0",
    ]);
    expect(formatFixed(result.finalValue)).toBe("1210");
    expect(formatFixed(result.initialCash)).toBe("1000");
  });

  it("applies accrual, then fills, then snapshot in that fixed order", () => {
    const { strategy } = buyAndHold(X, whole(9n));
    const result = runBacktest({
      clock: clockFrom([100, 110]),
      strategy,
      initialCash: parseFixed("1000"),
      execution: { slippageBps: 100n, feeBps: 50n },
      accrual: {
        cashRate: parseFixed("0.01"),
        fundingRate: parseFixed("0.005"),
      },
    });

    // Tick 0: 1000 earns 10 interest -> 1010 cash; buying 9 at a 1% slippage
    // (exec 101) costs 909 + 4.545 fee = 913.545 -> cash 96.455.
    // Tick 1: 96.455 earns 0.96455 interest, 9 units at 110 pay 4.95 funding.
    expect(result.snapshots.map((s) => formatFixed(s.cash))).toEqual([
      "96.455",
      "92.46955",
    ]);
    expect(result.snapshots.map((s) => formatFixed(s.value))).toEqual([
      "996.455",
      "1082.46955",
    ]);
    expect(formatFixed(result.totalInterest)).toBe("10.96455");
    expect(formatFixed(result.totalFunding)).toBe("4.95");
    expect(formatFixed(result.totalFees)).toBe("4.545");
  });

  it("produces byte-identical snapshots for identical inputs", () => {
    const build = (): BacktestResult => {
      const { strategy } = buyAndHold(X, whole(9n));
      return runBacktest({
        clock: clockFrom([100, 108, 99, 121]),
        strategy,
        initialCash: whole(1000n),
        execution: { slippageBps: 25n, feeBps: 10n },
        accrual: {
          cashRate: parseFixed("0.0001"),
          fundingRate: parseFixed("0.0002"),
        },
      });
    };

    const first = build();
    const second = build();
    expect(serializeSnapshots(first.snapshots)).toBe(
      serializeSnapshots(second.snapshots)
    );
    expect(() => JSON.parse(serializeSnapshots(first.snapshots))).not.toThrow();
  });

  it("serializes snapshots to a canonical, stable string", () => {
    const { strategy } = buyAndHold(X, whole(10n));
    const result = runBacktest({
      clock: clockFrom([100, 110]),
      strategy,
      initialCash: whole(1000n),
      execution: ZERO_COST,
      accrual: NO_ACCRUAL,
    });
    const expected = [
      '[{"tick":0,"timestamp":0,"cash":"0","positions":{"XLM":"10"},',
      '"value":"1000"},{"tick":1,"timestamp":60000,"cash":"0",',
      '"positions":{"XLM":"10"},"value":"1100"}]',
    ].join("");
    expect(serializeSnapshots(result.snapshots)).toBe(expected);
  });

  it("records sorted positions on every snapshot", () => {
    const strategy: Strategy = {
      id: "two-asset",
      onTick: () => [
        { asset: "BBB", side: "buy", quantity: whole(1n) },
        { asset: "AAA", side: "buy", quantity: whole(1n) },
      ],
    };
    const clock = createClock({
      startTime: 0,
      stepMs: 1,
      pricePath: [{ BBB: whole(1n), AAA: whole(2n) }],
    });
    const result = runBacktest({
      clock,
      strategy,
      initialCash: whole(100n),
      execution: ZERO_COST,
      accrual: NO_ACCRUAL,
    });

    const snapshot = result.snapshots[0];
    expect(snapshot).toBeDefined();
    expect(Object.keys(snapshot?.positions ?? {})).toEqual(["AAA", "BBB"]);
    expect(formatFixed(snapshot?.value ?? 0n)).toBe("100");
  });

  it("rejects invalid orders, prices and configuration", () => {
    const overBuy: Strategy = {
      id: "over-buy",
      onTick: () => [{ asset: X, side: "buy", quantity: whole(2n) }],
    };
    expect(() =>
      runBacktest({
        clock: clockFrom([100]),
        strategy: overBuy,
        initialCash: whole(1n),
        execution: ZERO_COST,
        accrual: NO_ACCRUAL,
      })
    ).toThrow(/insufficient cash/);

    const overSell: Strategy = {
      id: "over-sell",
      onTick: () => [{ asset: X, side: "sell", quantity: whole(1n) }],
    };
    expect(() =>
      runBacktest({
        clock: clockFrom([100]),
        strategy: overSell,
        initialCash: whole(100n),
        execution: ZERO_COST,
        accrual: NO_ACCRUAL,
      })
    ).toThrow(/insufficient "XLM" to sell/);

    const unknownAsset: Strategy = {
      id: "unknown",
      onTick: () => [{ asset: "NOPE", side: "buy", quantity: whole(1n) }],
    };
    expect(() =>
      runBacktest({
        clock: clockFrom([100]),
        strategy: unknownAsset,
        initialCash: whole(100n),
        execution: ZERO_COST,
        accrual: NO_ACCRUAL,
      })
    ).toThrow(/no price for "NOPE"/);

    expect(() =>
      runBacktest({
        clock: clockFrom([100]),
        strategy: overBuy,
        initialCash: whole(1n),
        execution: { slippageBps: 10_000n, feeBps: 0n },
        accrual: NO_ACCRUAL,
      })
    ).toThrow(/slippageBps/);
  });

  it("holds the runner implementation under 400 lines of non-test code", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    );
    let lines = 0;
    for (const file of files) {
      for (const raw of readFileSync(join(dir, file), "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("//") || line.startsWith("*")) continue;
        if (line.startsWith("/*")) continue;
        lines += 1;
      }
    }
    expect(lines).toBeLessThan(400);
  });
});
