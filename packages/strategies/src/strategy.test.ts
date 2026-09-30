import { describe, it, expect } from "vitest";
import {
  BuyAndHoldStrategy,
  StrategyLifecycle,
  LifecycleOrderError,
  FixedPointDecimal,
} from "./index";
import type {
  AssetSymbol,
  Order,
  PortfolioView,
  PositionView,
  Strategy,
  StrategyContext,
} from "./index";

const D = (v: string) => FixedPointDecimal.fromString(v);
const USDC: AssetSymbol = "USDC";
const T0 = 1_700_000_000_000;

/** Minimal runner-side portfolio: applies orders as fills at market price. */
class FakePortfolio implements PortfolioView {
  cash: FixedPointDecimal;
  #size = 0n;
  constructor(cash: FixedPointDecimal) {
    this.cash = cash;
  }
  getPosition(asset: AssetSymbol): PositionView | undefined {
    if (this.#size === 0n) return undefined;
    return {
      asset,
      size: FixedPointDecimal.fromStroops(this.#size),
      basis: D("0"),
    };
  }
  positions(): readonly PositionView[] {
    const p = this.getPosition(USDC);
    return p ? [p] : [];
  }
  totalValue(prices: ReadonlyMap<AssetSymbol, FixedPointDecimal>) {
    const price = prices.get(USDC)!.toStroops();
    return FixedPointDecimal.fromStroops(
      this.cash.toStroops() + (this.#size * price) / 10_000_000n
    );
  }
  fill(order: Order, price: FixedPointDecimal) {
    this.#size += order.size.toStroops();
    this.cash = FixedPointDecimal.fromStroops(
      this.cash.toStroops() -
        (order.size.toStroops() * price.toStroops()) / 10_000_000n
    );
  }
}

function ctx(
  portfolio: PortfolioView,
  tick: number,
  price = "2"
): StrategyContext {
  return {
    market: {
      timestamp: T0 + tick * 3_600_000,
      prices: new Map([[USDC, D(price)]]),
    },
    portfolio,
  };
}

describe("BuyAndHoldStrategy through the full lifecycle", () => {
  it("buys once, holds, and unwinds at close", () => {
    const portfolio = new FakePortfolio(D("1000"));
    const run = new StrategyLifecycle(new BuyAndHoldStrategy());
    run.init({ startingCapital: D("1000"), config: { asset: USDC } });

    const allOrders: Order[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const price = tick === 2 ? "3" : "2";
      const c = ctx(portfolio, tick, price);
      run.step(c);
      for (const o of run.rebalance(c)) {
        portfolio.fill(o, c.market.prices.get(USDC)!);
        allOrders.push(o);
      }
    }
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0]?.size.toString()).toBe("500");
    expect(
      portfolio.totalValue(ctx(portfolio, 2, "3").market.prices).toString()
    ).toBe("1500");

    const closeCtx = ctx(portfolio, 2, "3");
    const closing = run.close(closeCtx);
    expect(closing).toHaveLength(1);
    expect(closing[0]?.size.toString()).toBe("-500");
    portfolio.fill(closing[0]!, closeCtx.market.prices.get(USDC)!);
    expect(portfolio.cash.toString()).toBe("1500");
    expect(run.phase).toBe("closed");
  });

  it("does not mutate portfolio state itself", () => {
    const portfolio = new FakePortfolio(D("1000"));
    const strategy = new BuyAndHoldStrategy();
    strategy.init({ startingCapital: D("1000"), config: { asset: USDC } });
    const c = ctx(portfolio, 0);
    strategy.step(c);
    strategy.rebalance(c);
    expect(portfolio.cash.toString()).toBe("1000");
    expect(portfolio.positions()).toHaveLength(0);
  });
});

describe("StrategyLifecycle order enforcement", () => {
  const make = () => {
    const strategy: Strategy<null> = {
      name: "noop",
      init: () => {},
      step: () => {},
      rebalance: () => [],
      close: () => [],
    };
    return new StrategyLifecycle(strategy);
  };
  const p = new FakePortfolio(D("0"));

  it("rejects step before init", () => {
    expect(() => make().step(ctx(p, 0))).toThrow(LifecycleOrderError);
  });

  it("rejects double init", () => {
    const run = make();
    run.init({ startingCapital: D("1"), config: null });
    expect(() => run.init({ startingCapital: D("1"), config: null })).toThrow(
      LifecycleOrderError
    );
  });

  it("rejects rebalance without a step, and two steps in a row", () => {
    const run = make();
    run.init({ startingCapital: D("1"), config: null });
    expect(() => run.rebalance(ctx(p, 0))).toThrow(LifecycleOrderError);
    run.step(ctx(p, 0));
    expect(() => run.step(ctx(p, 1))).toThrow(LifecycleOrderError);
  });

  it("rejects non-increasing timestamps", () => {
    const run = make();
    run.init({ startingCapital: D("1"), config: null });
    run.step(ctx(p, 1));
    run.rebalance(ctx(p, 1));
    expect(() => run.step(ctx(p, 1))).toThrow(LifecycleOrderError);
  });

  it("rejects close mid-tick and any call after close", () => {
    const run = make();
    run.init({ startingCapital: D("1"), config: null });
    run.step(ctx(p, 0));
    expect(() => run.close(ctx(p, 0))).toThrow(LifecycleOrderError);
    run.rebalance(ctx(p, 0));
    run.close(ctx(p, 0));
    expect(() => run.step(ctx(p, 1))).toThrow(LifecycleOrderError);
    expect(() => run.close(ctx(p, 1))).toThrow(LifecycleOrderError);
  });
});
