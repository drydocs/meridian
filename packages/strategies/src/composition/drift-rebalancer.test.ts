import { describe, expect, it } from "vitest";

import { ONE_HOUR_MS } from "../clock";
import type {
  Order,
  PortfolioView,
  PositionView,
  Strategy,
  StrategyContext,
} from "../strategy";
import { FixedPointDecimal } from "../types";
import type { AssetSymbol } from "../types";
import { CompositionConstraintError } from "./constraint-engine";
import {
  computeDriftRebalance,
  validateDriftRebalanceConfig,
} from "./drift-rebalancer";
import { ComposedStrategy } from "./index";

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";
const XLM: AssetSymbol = "XLM";
const START = 1_700_000_000_000;
const dec = (value: string) => FixedPointDecimal.fromString(value);

function staticPortfolio(
  cash: string,
  positions: ReadonlyArray<{
    asset: AssetSymbol;
    size: string;
    memberId?: string;
  }>
): PortfolioView {
  const views: PositionView[] = positions.map((position) => ({
    asset: position.asset,
    size: dec(position.size),
    basis: dec("0"),
    ...(position.memberId === undefined ? {} : { memberId: position.memberId }),
  }));
  return {
    cash: dec(cash),
    getPosition: (asset) => views.find((view) => view.asset === asset),
    positions: () => views,
    totalValue: (prices) => {
      let total = dec(cash);
      for (const view of views) {
        const price = prices.get(view.asset);
        if (price === undefined) {
          throw new RangeError(`no price for ${view.asset}`);
        }
        total = total.add(view.size.mul(price));
      }
      return total;
    },
  };
}

function noopStrategy(name = "noop"): Strategy<unknown> {
  return {
    name,
    init: () => {},
    step: () => {},
    rebalance: () => [],
    close: () => [],
  };
}

function contextAt(
  timestamp: number,
  prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>,
  portfolio: PortfolioView
): StrategyContext {
  return {
    market: { timestamp, prices },
    portfolio,
  };
}

describe("validateDriftRebalanceConfig", () => {
  it("rejects empty config with neither threshold nor calendarIntervalMs", () => {
    expect(() => validateDriftRebalanceConfig({})).toThrow(RangeError);
  });

  it("rejects out-of-range threshold and non-positive calendarIntervalMs", () => {
    expect(() =>
      validateDriftRebalanceConfig({ threshold: dec("-0.01") })
    ).toThrow(RangeError);
    expect(() =>
      validateDriftRebalanceConfig({ threshold: dec("1.01") })
    ).toThrow(RangeError);
    expect(() =>
      validateDriftRebalanceConfig({ calendarIntervalMs: 0 })
    ).toThrow(RangeError);
    expect(() =>
      validateDriftRebalanceConfig({ calendarIntervalMs: -1000 })
    ).toThrow(RangeError);
    expect(() =>
      validateDriftRebalanceConfig({ calendarIntervalMs: 1.5 })
    ).toThrow(RangeError);
  });

  it("accepts threshold-only, calendar-only, and combined configs", () => {
    expect(() =>
      validateDriftRebalanceConfig({ threshold: dec("0.05") })
    ).not.toThrow();
    expect(() =>
      validateDriftRebalanceConfig({ calendarIntervalMs: ONE_HOUR_MS })
    ).not.toThrow();
    expect(() =>
      validateDriftRebalanceConfig({
        threshold: dec("0.05"),
        calendarIntervalMs: ONE_HOUR_MS,
      })
    ).not.toThrow();
  });
});

describe("computeDriftRebalance", () => {
  const prices = new Map<AssetSymbol, FixedPointDecimal>([
    [USDC, dec("1")],
    [EURC, dec("1")],
    [XLM, dec("2")],
  ]);

  it("emits no orders when there is no drift", () => {
    const portfolio = staticPortfolio("100", [
      { asset: USDC, size: "500", memberId: "alpha" },
      { asset: EURC, size: "500", memberId: "beta" },
    ]);

    const result = computeDriftRebalance(
      { threshold: dec("0.05") },
      [
        { id: "alpha", targetWeight: dec("0.5") },
        { id: "beta", targetWeight: dec("0.5") },
      ],
      portfolio,
      prices,
      [],
      START,
      START
    );

    expect(result.triggered).toBe(false);
    expect(result.triggerReason).toBe("none");
    expect(result.orders).toEqual([]);
  });

  it("does not trigger when drift is within or equal to threshold", () => {
    // alpha = 550 (0.55), beta = 450 (0.45) -> abs drift = 0.05 == threshold
    const portfolio = staticPortfolio("0", [
      { asset: USDC, size: "550", memberId: "alpha" },
      { asset: EURC, size: "450", memberId: "beta" },
    ]);

    const result = computeDriftRebalance(
      { threshold: dec("0.05") },
      [
        { id: "alpha", targetWeight: dec("0.5") },
        { id: "beta", targetWeight: dec("0.5") },
      ],
      portfolio,
      prices,
      [],
      START,
      START
    );

    expect(result.triggered).toBe(false);
    expect(result.orders).toEqual([]);
  });

  it("triggers on threshold breach and restores weights within tolerance", () => {
    // alpha = 700 (0.70), beta = 300 (0.30) -> drift = +/- 0.20 > 0.05
    const portfolio = staticPortfolio("0", [
      { asset: USDC, size: "700", memberId: "alpha" },
      { asset: EURC, size: "300", memberId: "beta" },
    ]);

    const result = computeDriftRebalance(
      { threshold: dec("0.05") },
      [
        { id: "alpha", targetWeight: dec("0.5") },
        { id: "beta", targetWeight: dec("0.5") },
      ],
      portfolio,
      prices,
      [],
      START,
      START
    );

    expect(result.triggered).toBe(true);
    expect(result.triggerReason).toBe("threshold");
    expect(result.orders).toEqual([
      {
        asset: USDC,
        size: dec("-200"),
        memberId: "alpha",
        reason: "drift-rebalance",
      },
      {
        asset: EURC,
        size: dec("200"),
        memberId: "beta",
        reason: "drift-rebalance",
      },
    ]);

    // Verify post-rebalance weights match targets exactly.
    const postAlpha = 700 + Number(result.orders[0]!.size.toString());
    const postBeta = 300 + Number(result.orders[1]!.size.toString());
    expect(postAlpha / (postAlpha + postBeta)).toBeCloseTo(0.5, 6);
    expect(postBeta / (postAlpha + postBeta)).toBeCloseTo(0.5, 6);
  });

  it("triggers on calendar interval even when drift is below threshold", () => {
    // alpha = 520 (0.52), beta = 480 (0.48) -> drift = 0.02 < 0.05
    const portfolio = staticPortfolio("0", [
      { asset: USDC, size: "520", memberId: "alpha" },
      { asset: EURC, size: "480", memberId: "beta" },
    ]);

    const beforeInterval = computeDriftRebalance(
      { threshold: dec("0.05"), calendarIntervalMs: ONE_HOUR_MS },
      [
        { id: "alpha", targetWeight: dec("0.5") },
        { id: "beta", targetWeight: dec("0.5") },
      ],
      portfolio,
      prices,
      [],
      START + ONE_HOUR_MS - 1,
      START
    );
    expect(beforeInterval.triggered).toBe(false);
    expect(beforeInterval.orders).toEqual([]);

    const atInterval = computeDriftRebalance(
      { threshold: dec("0.05"), calendarIntervalMs: ONE_HOUR_MS },
      [
        { id: "alpha", targetWeight: dec("0.5") },
        { id: "beta", targetWeight: dec("0.5") },
      ],
      portfolio,
      prices,
      [],
      START + ONE_HOUR_MS,
      START
    );
    expect(atInterval.triggered).toBe(true);
    expect(atInterval.triggerReason).toBe("calendar");
    expect(atInterval.orders).toEqual([
      {
        asset: USDC,
        size: dec("-20"),
        memberId: "alpha",
        reason: "drift-rebalance",
      },
      {
        asset: EURC,
        size: dec("20"),
        memberId: "beta",
        reason: "drift-rebalance",
      },
    ]);
  });

  it("breaks ties deterministically: sells before buys, largest drift first, then declaration order", () => {
    // Targets: a=0.25, b=0.25, c=0.25, d=0.25
    // Actuals: a=350 (+0.10), b=350 (+0.10), c=150 (-0.10), d=150 (-0.10)
    // Ties within overweight (a vs b) and underweight (c vs d) break by declaration order.
    const portfolio = staticPortfolio("0", [
      { asset: USDC, size: "350", memberId: "a" },
      { asset: EURC, size: "350", memberId: "b" },
      { asset: USDC, size: "150", memberId: "c" },
      { asset: EURC, size: "150", memberId: "d" },
    ]);

    const result = computeDriftRebalance(
      { threshold: dec("0.05") },
      [
        { id: "a", targetWeight: dec("0.25") },
        { id: "b", targetWeight: dec("0.25") },
        { id: "c", targetWeight: dec("0.25") },
        { id: "d", targetWeight: dec("0.25") },
      ],
      portfolio,
      prices,
      [],
      START,
      START
    );

    expect(result.triggered).toBe(true);
    expect(result.orders.map((o) => o.memberId)).toEqual(["a", "b", "c", "d"]);
    expect(result.orders.map((o) => o.size.toString())).toEqual([
      "-100",
      "-100",
      "100",
      "100",
    ]);
  });

  it("orders multi-asset member rebalance orders lexicographically by asset", () => {
    // alpha holds XLM (200 @ $2 = 400) and EURC (400 @ $1 = 400) -> total 800
    // beta holds USDC (200 @ $1 = 200) -> total 200
    // Target 50/50 -> alpha sells 300 (150 EURC, 75 XLM), beta buys 300 USDC
    const portfolio = staticPortfolio("0", [
      { asset: XLM, size: "200", memberId: "alpha" },
      { asset: EURC, size: "400", memberId: "alpha" },
      { asset: USDC, size: "200", memberId: "beta" },
    ]);

    const result = computeDriftRebalance(
      { threshold: dec("0.05") },
      [
        { id: "alpha", targetWeight: dec("0.5") },
        { id: "beta", targetWeight: dec("0.5") },
      ],
      portfolio,
      prices,
      [],
      START,
      START
    );

    expect(result.orders).toEqual([
      {
        asset: EURC,
        size: dec("-150"),
        memberId: "alpha",
        reason: "drift-rebalance",
      },
      {
        asset: XLM,
        size: dec("-75"),
        memberId: "alpha",
        reason: "drift-rebalance",
      },
      {
        asset: USDC,
        size: dec("300"),
        memberId: "beta",
        reason: "drift-rebalance",
      },
    ]);
  });
});

describe("ComposedStrategy drift rebalancing with constraints", () => {
  const prices = new Map<AssetSymbol, FixedPointDecimal>([
    [USDC, dec("1")],
    [EURC, dec("1")],
  ]);

  it("triggers calendar rebalance on ComposedStrategy after interval elapses", () => {
    const composed = new ComposedStrategy(
      [
        {
          id: "alpha",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
        {
          id: "beta",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
      ],
      undefined,
      { calendarIntervalMs: ONE_HOUR_MS }
    );

    composed.init({ startingCapital: dec("1000"), config: undefined });

    const drifted = staticPortfolio("0", [
      { asset: USDC, size: "600", memberId: "alpha" },
      { asset: EURC, size: "400", memberId: "beta" },
    ]);

    // Tick 0 establishes baseline timestamp; no calendar rebalance yet.
    expect(composed.rebalance(contextAt(START, prices, drifted))).toEqual([]);

    // Tick 1 at +1 hour triggers calendar rebalance.
    const orders = composed.rebalance(
      contextAt(START + ONE_HOUR_MS, prices, drifted)
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      asset: USDC,
      size: dec("-100"),
      memberId: "alpha",
    });
    expect(orders[1]).toMatchObject({
      asset: EURC,
      size: dec("100"),
      memberId: "beta",
    });
  });

  it("rejects drift rebalance orders that violate maxAggregateExposure", () => {
    // alpha holds 700 USDC, beta holds 300 EURC.
    // Drift rebalance wants beta to buy 200 EURC (aggregate EURC = 500/1000 = 0.50).
    // With maxAggregateExposure = 0.40, EURC would breach 0.40 -> rejected.
    const composed = new ComposedStrategy(
      [
        {
          id: "alpha",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
        {
          id: "beta",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
      ],
      {
        constraints: { maxAggregateExposure: dec("0.4") },
        mode: "reject",
      },
      { threshold: dec("0.05") }
    );

    composed.init({ startingCapital: dec("1000"), config: undefined });

    const portfolio = staticPortfolio("0", [
      { asset: USDC, size: "700", memberId: "alpha" },
      { asset: EURC, size: "300", memberId: "beta" },
    ]);

    expect(() =>
      composed.rebalance(contextAt(START, prices, portfolio))
    ).toThrow(CompositionConstraintError);
  });

  it("clamps drift rebalance orders when maxAggregateExposure is in clamp mode", () => {
    // Total portfolio value = 1000 (100 cash + 600 USDC + 300 EURC).
    // Deployed value = 900 -> target 450 each -> alpha sells 150 USDC, beta buys 150 EURC.
    // Post-trade EURC = 450 (45% of 1000), which exceeds maxAggregateExposure = 0.40 (400).
    // In clamp mode, beta's EURC buy is trimmed from 150 to 100.
    const composed = new ComposedStrategy(
      [
        {
          id: "alpha",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
        {
          id: "beta",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
      ],
      {
        constraints: { maxAggregateExposure: dec("0.4") },
        mode: "clamp",
      },
      { threshold: dec("0.05") }
    );

    composed.init({ startingCapital: dec("1000"), config: undefined });

    const portfolio = staticPortfolio("100", [
      { asset: USDC, size: "600", memberId: "alpha" },
      { asset: EURC, size: "300", memberId: "beta" },
    ]);

    const orders: readonly Order[] = composed.rebalance(
      contextAt(START, prices, portfolio)
    );
    const eurcBuy = orders.find(
      (o) => o.memberId === "beta" && o.asset === EURC
    );
    expect(eurcBuy).toBeDefined();
    expect(eurcBuy!.size.toString()).toBe("100");
  });

  it("blocks rebalancing when minCashBuffer constraint is violated", () => {
    // Cash is 50 out of 1000 (5%), below minCashBuffer of 10%.
    // Even though drift orders are cash-neutral, post-rebalance cash buffer is
    // still 5% < 10%, so constraint enforcement rejects the rebalance.
    const composed = new ComposedStrategy(
      [
        {
          id: "alpha",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
        {
          id: "beta",
          strategy: noopStrategy(),
          allocation: dec("0.5"),
          config: undefined,
        },
      ],
      {
        constraints: { minCashBuffer: dec("0.1") },
        mode: "reject",
      },
      { threshold: dec("0.05") }
    );

    composed.init({ startingCapital: dec("1000"), config: undefined });

    const portfolio = staticPortfolio("50", [
      { asset: USDC, size: "650", memberId: "alpha" },
      { asset: EURC, size: "300", memberId: "beta" },
    ]);

    expect(() =>
      composed.rebalance(contextAt(START, prices, portfolio))
    ).toThrow(CompositionConstraintError);
  });
});
