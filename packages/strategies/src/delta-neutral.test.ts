import { describe, it, expect } from "vitest";
import { FixedPointDecimal } from "./types";
import type {
  AssetSymbol,
  FundingRate,
  PriceFeed,
  SimulationTimestamp,
} from "./types";
import { BacktestPriceFeed, StaticPriceFeed } from "./feeds";
import { Portfolio } from "./portfolio";
import { SizingError } from "./sizing";
import { LifecycleOrderError, StrategyLifecycle } from "./strategy";
import type { StrategyContext } from "./strategy";
import {
  DeltaNeutralConfigError,
  DeltaNeutralStrategy,
  ModeledHedgeVenue,
  isDeltaNeutralConfigError,
} from "./delta-neutral";
import type { DeltaNeutralConfig } from "./delta-neutral";

const USDC: AssetSymbol = "USDC";

const T0: SimulationTimestamp = 1_700_000_000_000;
const STEP = 3_600_000;

const CAPITAL = FixedPointDecimal.fromString("10000");
const LEVERAGE = FixedPointDecimal.fromString("2");
const SPOT_LEG = "20000";
const HEDGE_NOTIONAL = "20000";

/** 1e-7 per second, so one 3600s tick pays 7.2 quote units on 20000 notional. */
const FUNDING_RATE: FundingRate = {
  ratePerSecond: FixedPointDecimal.fromString("0.0000001"),
};

// 1.0000 → +5bps (drift inside the 50bps band) → +2% (drift leaves the band) →
// flat, so the last tick only accrues funding.
const spotPrices = BacktestPriceFeed.create({
  USDC: [
    { timestamp: T0, price: "1.0000000" },
    { timestamp: T0 + STEP, price: "1.0005000" },
    { timestamp: T0 + 2 * STEP, price: "1.0200000" },
    { timestamp: T0 + 3 * STEP, price: "1.0200000" },
  ],
  EURC: [],
});

function marketTick(
  feed: PriceFeed,
  timestamp: SimulationTimestamp
): StrategyContext {
  return {
    market: {
      timestamp,
      prices: new Map<AssetSymbol, FixedPointDecimal>([
        [USDC, feed.getSpotPrice(USDC, timestamp)],
      ]),
    },
    portfolio: new Portfolio(FixedPointDecimal.fromStroops(0n)),
  };
}

const BASE_CONFIG: DeltaNeutralConfig = {
  asset: USDC,
  targetLeverage: LEVERAGE,
  rebalanceBandBps: 50,
  fundingRate: FUNDING_RATE,
  priceFeed: spotPrices,
};

function configured(
  overrides: Partial<DeltaNeutralConfig> = {}
): DeltaNeutralStrategy {
  const strategy = new DeltaNeutralStrategy();
  strategy.init({
    startingCapital: CAPITAL,
    config: { ...BASE_CONFIG, ...overrides },
  });
  return strategy;
}

/** Runs ticks 0..3 in lifecycle order. */
function runFixture(): DeltaNeutralStrategy {
  const strategy = configured();
  for (let tick = 0; tick <= 3; tick += 1) {
    const context = marketTick(spotPrices, T0 + tick * STEP);
    strategy.step(context);
    strategy.rebalance(context);
  }
  return strategy;
}

describe("DeltaNeutralStrategy entry", () => {
  it("funds both legs at init without ordering anything", () => {
    const strategy = new DeltaNeutralStrategy();
    strategy.init({ startingCapital: CAPITAL, config: BASE_CONFIG });

    expect(strategy.name).toBe("delta-neutral");
    expect(strategy.isOpen).toBe(false);
    expect(strategy.spotQuantity.toStroops()).toBe(0n);
    expect(strategy.hedgeQuoteNotional.toStroops()).toBe(0n);
    // Both legs post their margin before either is opened, so the book is
    // funded with twice the starting capital.
    expect(strategy.equity.toString()).toBe("20000");
  });

  it("opens the spot leg with a matching hedge at the first rebalance", () => {
    const strategy = configured();

    const orders = strategy.rebalance(marketTick(spotPrices, T0));

    expect(orders).toHaveLength(1);
    expect(orders[0]!.asset).toBe(USDC);
    expect(orders[0]!.size.toString()).toBe(SPOT_LEG);
    expect(orders[0]!.reason).toBe("open the spot leg");

    expect(strategy.isOpen).toBe(true);
    expect(strategy.spotQuantity.toString()).toBe(SPOT_LEG);
    expect(strategy.hedgeQuoteNotional.toString()).toBe(HEDGE_NOTIONAL);
    expect(strategy.entryPrice.toString()).toBe("1");
    expect(strategy.lastTimestamp).toBe(T0);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.netDeltaNotional.toStroops()).toBe(0n);
    expect(strategy.rebalanceCount).toBe(0);
  });

  it("sizes through the merged #926 sizer, surfacing its validation", () => {
    const strategy = configured({
      targetLeverage: FixedPointDecimal.fromString("0"),
    });

    expect(() => strategy.rebalance(marketTick(spotPrices, T0))).toThrow(
      SizingError
    );
  });

  it("rejects a band that is not a non-negative integer count of bps", () => {
    expect(() => configured({ rebalanceBandBps: 50.5 })).toThrow(
      DeltaNeutralConfigError
    );
    expect(() => configured({ rebalanceBandBps: -1 })).toThrow(
      DeltaNeutralConfigError
    );
  });

  it("rejects non-positive starting capital", () => {
    const strategy = new DeltaNeutralStrategy();
    expect(() =>
      strategy.init({
        startingCapital: FixedPointDecimal.fromStroops(0n),
        config: BASE_CONFIG,
      })
    ).toThrow(DeltaNeutralConfigError);
  });

  it("reports a zero hedge and no id before init", () => {
    const strategy = new DeltaNeutralStrategy();

    expect(strategy.hedgeQuoteNotional.toStroops()).toBe(0n);
    expect(() => strategy.id).toThrow(LifecycleOrderError);
  });

  it("identifies its own config errors", () => {
    expect(isDeltaNeutralConfigError(new DeltaNeutralConfigError("bad"))).toBe(
      true
    );
    expect(isDeltaNeutralConfigError(new Error("bad"))).toBe(false);
  });

  it("rejects a non-positive spot price", () => {
    const zeroPrices = StaticPriceFeed.create({ USDC: "0", EURC: "1" });
    const strategy = configured({ priceFeed: zeroPrices });

    expect(() => strategy.rebalance(marketTick(zeroPrices, T0))).toThrow(
      DeltaNeutralConfigError
    );
  });
});

describe("DeltaNeutralStrategy stepping", () => {
  it("tracks net delta each tick and accrues funding in integer stroops", () => {
    const strategy = configured();
    strategy.rebalance(marketTick(spotPrices, T0));

    strategy.step(marketTick(spotPrices, T0 + STEP));

    // Price rose, so the quote-notional short is worth fewer base units and the
    // book is momentarily net long.
    expect(strategy.netDelta.toString()).toBe("9.9950025");
    expect(strategy.netDeltaNotional.toString()).toBe("10");

    // Neutral at entry, so the mark cancels exactly and only funding accrues.
    expect(strategy.pricePnl.toStroops()).toBe(0n);
    expect(strategy.fundingPnl.toString()).toBe("7.2");
    expect(strategy.rebalanceCount).toBe(0);

    const history = strategy.deltaHistory;
    expect(history).toHaveLength(2);
    expect(history[0]!.tick).toBe(0);
    expect(history[1]!.tick).toBe(1);
    expect(history[1]!.rebalanced).toBe(false);
    expect(history[1]!.netDelta.toStroops()).toBe(
      strategy.netDelta.toStroops()
    );
  });

  it("leaves the book alone while drift stays inside the band", () => {
    const strategy = configured();
    strategy.rebalance(marketTick(spotPrices, T0));
    strategy.step(marketTick(spotPrices, T0 + STEP));

    const orders = strategy.rebalance(marketTick(spotPrices, T0 + STEP));

    expect(orders).toHaveLength(0);
    expect(strategy.rebalanceCount).toBe(0);
    expect(strategy.hedgeQuoteNotional.toString()).toBe(HEDGE_NOTIONAL);
  });

  it("restores neutrality when drift leaves the band", () => {
    const strategy = configured();
    strategy.rebalance(marketTick(spotPrices, T0));
    strategy.step(marketTick(spotPrices, T0 + STEP));
    strategy.rebalance(marketTick(spotPrices, T0 + STEP));

    strategy.step(marketTick(spotPrices, T0 + 2 * STEP));
    expect(strategy.netDeltaNotional.toString()).toBe("400");

    const orders = strategy.rebalance(marketTick(spotPrices, T0 + 2 * STEP));

    // The hedge lives only in the modeled venue, which the runner cannot fill,
    // so adjusting it produces no order.
    expect(orders).toHaveLength(0);
    expect(strategy.rebalanceCount).toBe(1);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.netDeltaNotional.toStroops()).toBe(0n);
    expect(strategy.hedgeQuoteNotional.toString()).toBe("20400");
    // The drift carried into the move is real PnL.
    expect(strategy.pricePnl.toString()).toBe("0.1949026");
    expect(strategy.fundingPnl.toString()).toBe("14.4");

    const last = strategy.deltaHistory[2]!;
    expect(last.rebalanced).toBe(true);
  });

  it("records the post-rebalance mark, not the drift that triggered it", () => {
    const strategy = configured();
    strategy.rebalance(marketTick(spotPrices, T0));
    strategy.step(marketTick(spotPrices, T0 + STEP));
    strategy.rebalance(marketTick(spotPrices, T0 + STEP));
    strategy.step(marketTick(spotPrices, T0 + 2 * STEP));
    strategy.rebalance(marketTick(spotPrices, T0 + 2 * STEP));

    strategy.step(marketTick(spotPrices, T0 + 3 * STEP));

    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.fundingPnl.toString()).toBe("21.744");
    expect(strategy.rebalanceCount).toBe(1);
    expect(strategy.deltaHistory[2]!.rebalanced).toBe(true);
    expect(strategy.deltaHistory[3]!.rebalanced).toBe(false);
  });

  it("trims the hedge when a falling price makes the book net short", () => {
    const falling = BacktestPriceFeed.create({
      USDC: [
        { timestamp: T0, price: "1.0000000" },
        { timestamp: T0 + STEP, price: "1.0000000" },
        { timestamp: T0 + 2 * STEP, price: "0.9800000" },
        { timestamp: T0 + 3 * STEP, price: "0.9800000" },
      ],
      EURC: [],
    });
    const strategy = configured({ priceFeed: falling });

    strategy.rebalance(marketTick(falling, T0));
    strategy.step(marketTick(falling, T0 + STEP));
    strategy.rebalance(marketTick(falling, T0 + STEP));

    strategy.step(marketTick(falling, T0 + 2 * STEP));
    expect(strategy.netDelta.toString()).toBe("-408.1632653");
    expect(strategy.netDeltaNotional.toString()).toBe("-399.9999999");

    const orders = strategy.rebalance(marketTick(falling, T0 + 2 * STEP));

    expect(orders).toHaveLength(0);
    expect(strategy.rebalanceCount).toBe(1);
    // The hedge shrinks back to the spot leg's marked value.
    expect(strategy.hedgeQuoteNotional.toString()).toBe("19600");
    expect(strategy.netDelta.toStroops()).toBe(0n);
    // Both legs marked from 1.00 to 0.98 still cancel, so a neutral book earns
    // nothing from price either way.
    expect(strategy.pricePnl.toStroops()).toBe(0n);
    expect(strategy.fundingPnl.toString()).toBe("14.4");
  });

  it("skips funding accrual for a non-positive elapsed interval", () => {
    const strategy = configured();
    strategy.rebalance(marketTick(spotPrices, T0));
    strategy.step(marketTick(spotPrices, T0 + STEP));
    const accrued = strategy.fundingPnl.toStroops();

    strategy.step(marketTick(spotPrices, T0 + STEP));
    expect(strategy.fundingPnl.toStroops()).toBe(accrued);

    strategy.step(marketTick(spotPrices, T0 + STEP + 500));
    expect(strategy.fundingPnl.toStroops()).toBe(accrued);
  });

  it("measures the band against total equity, not the leg notional", () => {
    // At 4x the leg notional (40000) is twice the book equity (20000), so a
    // notional-relative band would be twice as wide. This drift of 150 sits
    // above the equity band (100.072) and below the notional band (200), which
    // is exactly the case the two rules disagree on.
    const drifting = BacktestPriceFeed.create({
      USDC: [
        { timestamp: T0, price: "1.0000000" },
        { timestamp: T0 + STEP, price: "1.0037500" },
      ],
      EURC: [],
    });
    const strategy = configured({
      priceFeed: drifting,
      targetLeverage: FixedPointDecimal.fromString("4"),
    });

    strategy.rebalance(marketTick(drifting, T0));
    strategy.step(marketTick(drifting, T0 + STEP));

    expect(strategy.equity.toString()).toBe("20014.4");
    expect(strategy.netDeltaNotional.toString()).toBe("150");

    const orders = strategy.rebalance(marketTick(drifting, T0 + STEP));

    expect(orders).toHaveLength(0);
    expect(strategy.rebalanceCount).toBe(1);
    expect(strategy.hedgeQuoteNotional.toString()).toBe("40150");
  });
});

describe("DeltaNeutralStrategy close", () => {
  it("unwinds the spot leg and reports the book equity", () => {
    const strategy = runFixture();

    const orders = strategy.close(marketTick(spotPrices, T0 + 3 * STEP));

    expect(orders).toHaveLength(1);
    expect(orders[0]!.asset).toBe(USDC);
    expect(orders[0]!.size.toString()).toBe(`-${SPOT_LEG}`);
    expect(orders[0]!.reason).toBe("unwind at run end");

    expect(strategy.isClosed).toBe(true);
    expect(strategy.isOpen).toBe(false);
    expect(strategy.spotQuantity.toStroops()).toBe(0n);
    expect(strategy.hedgeQuoteNotional.toStroops()).toBe(0n);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    // The hedge feed defaults to the spot feed, so no basis is realized.
    expect(strategy.basisPnl.toStroops()).toBe(0n);
    expect(strategy.totalPnl.toString()).toBe("21.9389026");
  });

  it("reports equity as the two leg margins plus PnL, not capital plus PnL", () => {
    const strategy = runFixture();
    strategy.close(marketTick(spotPrices, T0 + 3 * STEP));

    const doubled = CAPITAL.toStroops() * 2n;
    expect(strategy.equity.toString()).toBe("20021.9389026");
    expect(strategy.equity.toStroops()).toBe(
      doubled + strategy.totalPnl.toStroops()
    );
    expect(strategy.equity.toStroops()).not.toBe(
      CAPITAL.toStroops() + strategy.totalPnl.toStroops()
    );
    expect(strategy.lastTimestamp).toBe(T0 + 3 * STEP);
  });

  it("realizes the basis when the perp converges to spot", () => {
    const flatSpot = BacktestPriceFeed.create({
      USDC: [
        { timestamp: T0, price: "1.0000000" },
        { timestamp: T0 + STEP, price: "1.0000000" },
        { timestamp: T0 + 2 * STEP, price: "1.0000000" },
        { timestamp: T0 + 3 * STEP, price: "1.0000000" },
      ],
      EURC: [],
    });
    const convergingHedge = BacktestPriceFeed.create({
      USDC: [
        { timestamp: T0, price: "1.0010000" },
        { timestamp: T0 + STEP, price: "1.0010000" },
        { timestamp: T0 + 2 * STEP, price: "1.0010000" },
        { timestamp: T0 + 3 * STEP, price: "1.0000000" },
      ],
      EURC: [],
    });

    const strategy = new DeltaNeutralStrategy();
    strategy.init({
      startingCapital: CAPITAL,
      config: {
        asset: USDC,
        targetLeverage: LEVERAGE,
        rebalanceBandBps: 50,
        fundingRate: FUNDING_RATE,
        priceFeed: flatSpot,
        hedgeFeed: convergingHedge,
      },
    });

    strategy.rebalance(marketTick(flatSpot, T0));
    strategy.step(marketTick(flatSpot, T0 + STEP));
    strategy.rebalance(marketTick(flatSpot, T0 + STEP));
    strategy.step(marketTick(flatSpot, T0 + 2 * STEP));
    strategy.rebalance(marketTick(flatSpot, T0 + 2 * STEP));
    strategy.close(marketTick(flatSpot, T0 + 3 * STEP));

    // Short at 1.001, covered at 1.000 on 20000 units: 20 quote units.
    expect(strategy.basisPnl.toString()).toBe("20");
    // The hedge is marked at spot throughout, so the convergence never leaks
    // into the price PnL.
    expect(strategy.pricePnl.toStroops()).toBe(0n);
    expect(strategy.fundingPnl.toString()).toBe("14.4");
    expect(strategy.equity.toString()).toBe("20034.4");
  });

  it("closes a book that never entered without ordering anything", () => {
    const strategy = configured();

    const orders = strategy.close(marketTick(spotPrices, T0));

    expect(orders).toHaveLength(0);
    expect(strategy.isClosed).toBe(true);
    expect(strategy.snapshot().entered).toBe(false);
  });
});

describe("DeltaNeutralStrategy lifecycle", () => {
  it("rejects calls that arrive out of order", () => {
    const fresh = new DeltaNeutralStrategy();
    expect(() => fresh.step(marketTick(spotPrices, T0))).toThrow(
      LifecycleOrderError
    );
    expect(() => fresh.rebalance(marketTick(spotPrices, T0))).toThrow(
      LifecycleOrderError
    );

    fresh.init({ startingCapital: CAPITAL, config: BASE_CONFIG });
    expect(() =>
      fresh.init({ startingCapital: CAPITAL, config: BASE_CONFIG })
    ).toThrow(LifecycleOrderError);

    fresh.close(marketTick(spotPrices, T0 + STEP));
    expect(() => fresh.close(marketTick(spotPrices, T0 + STEP))).toThrow(
      LifecycleOrderError
    );
    expect(() => fresh.rebalance(marketTick(spotPrices, T0 + STEP))).toThrow(
      LifecycleOrderError
    );
    expect(() => fresh.step(marketTick(spotPrices, T0 + STEP))).toThrow(
      LifecycleOrderError
    );
  });

  it("drives cleanly through the merged StrategyLifecycle guard", () => {
    const strategy = new DeltaNeutralStrategy();
    const lifecycle = new StrategyLifecycle<DeltaNeutralConfig>(strategy);
    lifecycle.init({ startingCapital: CAPITAL, config: BASE_CONFIG });

    const ordersPerTick: number[] = [];
    for (let tick = 0; tick <= 3; tick += 1) {
      const context = marketTick(spotPrices, T0 + tick * STEP);
      lifecycle.step(context);
      ordersPerTick.push(lifecycle.rebalance(context).length);
    }

    expect(ordersPerTick).toEqual([1, 0, 0, 0]);
    expect(lifecycle.phase).toBe("rebalanced");

    const unwind = lifecycle.close(marketTick(spotPrices, T0 + 3 * STEP));
    expect(unwind).toHaveLength(1);
    expect(unwind[0]!.size.toString()).toBe(`-${SPOT_LEG}`);
    expect(lifecycle.phase).toBe("closed");
  });

  it("is deterministic across identical runs", () => {
    function run(): DeltaNeutralStrategy {
      const strategy = runFixture();
      strategy.close(marketTick(spotPrices, T0 + 3 * STEP));
      return strategy;
    }

    const a = run();
    const b = run();
    expect(a.equity.toString()).toBe(b.equity.toString());
    expect(a.totalPnl.toString()).toBe(b.totalPnl.toString());
    expect(a.hedgeQuoteNotional.toString()).toBe(
      b.hedgeQuoteNotional.toString()
    );
    expect(a.snapshot().rebalanceCount).toBe(b.snapshot().rebalanceCount);
    expect(a.deltaHistory.map((o) => o.netDelta.toString())).toEqual(
      b.deltaHistory.map((o) => o.netDelta.toString())
    );
  });
});

describe("ModeledHedgeVenue", () => {
  it("records each adjustment and rejects a short driven below zero", () => {
    const venue = new ModeledHedgeVenue();
    const price = FixedPointDecimal.fromString("1");

    venue.openShort(FixedPointDecimal.fromString("20000"), price, 0);
    venue.adjustShort(FixedPointDecimal.fromString("400"), price, 2);
    expect(venue.shortNotional.toString()).toBe("20400");
    expect(venue.fills).toHaveLength(2);

    expect(() =>
      venue.adjustShort(FixedPointDecimal.fromString("-30000"), price, 3)
    ).toThrow(DeltaNeutralConfigError);

    venue.closeShort(price, 4);
    expect(venue.shortNotional.toStroops()).toBe(0n);
  });

  it("rejects opening a second short over an open one", () => {
    const venue = new ModeledHedgeVenue();
    const price = FixedPointDecimal.fromString("1");
    venue.openShort(FixedPointDecimal.fromString("20000"), price, 0);

    expect(() =>
      venue.openShort(FixedPointDecimal.fromString("20000"), price, 1)
    ).toThrow(LifecycleOrderError);
  });

  it("rejects a non-positive notional and a non-positive price", () => {
    const venue = new ModeledHedgeVenue();
    const price = FixedPointDecimal.fromString("1");

    expect(() =>
      venue.openShort(FixedPointDecimal.fromStroops(0n), price, 0)
    ).toThrow(DeltaNeutralConfigError);

    expect(() =>
      venue.openShort(
        FixedPointDecimal.fromString("20000"),
        FixedPointDecimal.fromStroops(0n),
        0
      )
    ).toThrow(RangeError);
  });
});
