import { describe, expect, it } from "vitest";
import { ONE_HOUR_MS, SimulationClock } from "./clock";
import { BacktestPriceFeed } from "./feeds";
import {
  FixedPointDecimal,
  InvalidFillError,
  InvalidVenueOperationError,
  Portfolio,
  UnknownAssetError,
  isVenueOrder,
  runBacktest,
  serializeSnapshots,
} from "./index";
import type {
  AssetSymbol,
  EngineOrder,
  Fill,
  Order,
  PriceSet,
  StrategyContext,
  VenueOrder,
  VenuePortfolioView,
  VenueStrategy,
} from "./index";

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";
const XLM: AssetSymbol = "XLM";
const START = 1_700_000_000_000;

const D = (v: string) => FixedPointDecimal.fromString(v);
const prices = (usdc = "1", eurc = "1.08", xlm = "0.20"): PriceSet =>
  new Map([
    [USDC, D(usdc)],
    [EURC, D(eurc)],
    [XLM, D(xlm)],
  ]);

describe("VenueLedger and Portfolio venue accounting (#1250)", () => {
  it("deploys cash to a named venue and exposes VenuePortfolioView", () => {
    const portfolio = new Portfolio(D("1000"));
    const view: VenuePortfolioView = portfolio;

    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "vault-a", asset: USDC, amount: D("400") },
      prices()
    );
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "vault-a", asset: USDC, amount: D("100") },
      prices()
    );
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "vault-b", asset: EURC, amount: D("100") },
      prices("1", "1.08")
    );

    expect(portfolio.cash.toString()).toBe("392");
    expect(view.getVenuePosition("vault-a", USDC)).toEqual({
      venueId: "vault-a",
      asset: USDC,
      deployedPrincipal: D("500"),
      accruedYield: D("0"),
    });
    expect(view.venues().map((v) => `${v.venueId}:${v.asset}`)).toEqual([
      "vault-a:USDC",
      "vault-b:EURC",
    ]);
    expect(portfolio.totalValue(prices("1", "1.08")).toString()).toBe("1000");
    portfolio.assertIdentity(prices("1", "1.08"));
  });

  it("harvests accrued yield to cash without changing deployed principal", () => {
    const portfolio = new Portfolio(D("1000"));
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "pool-1", asset: USDC, amount: D("600") },
      prices()
    );
    portfolio.accrueVenueYield("pool-1", USDC, D("25"));

    expect(portfolio.totalValue(prices()).toString()).toBe("1025");
    portfolio.assertIdentity(prices());

    // Partial harvest first, then full remaining harvest
    portfolio.applyVenueOrder(
      {
        kind: "harvest",
        venueId: "pool-1",
        asset: USDC,
        amount: D("10"),
      },
      prices()
    );
    expect(portfolio.cash.toString()).toBe("410");
    expect(portfolio.getVenuePosition("pool-1", USDC)).toEqual({
      venueId: "pool-1",
      asset: USDC,
      deployedPrincipal: D("600"),
      accruedYield: D("15"),
    });
    portfolio.assertIdentity(prices());

    portfolio.applyVenueOrder(
      { kind: "harvest", venueId: "pool-1", asset: USDC },
      prices()
    );
    expect(portfolio.cash.toString()).toBe("425");
    expect(
      portfolio.getVenuePosition("pool-1", USDC)?.deployedPrincipal.toString()
    ).toBe("600");
    expect(
      portfolio.getVenuePosition("pool-1", USDC)?.accruedYield.toString()
    ).toBe("0");
    expect(portfolio.realized.toString()).toBe("25");
    expect(portfolio.totalValue(prices()).toString()).toBe("1025");
    portfolio.assertIdentity(prices());
  });

  it("harvests accrued yield to reduce a linked debt and spills surplus to cash", () => {
    const portfolio = new Portfolio(D("1000"));
    portfolio.openDebt({
      debtId: "loan-1",
      asset: USDC,
      amount: D("200"),
      price: D("1"),
    });
    portfolio.openDebt({
      debtId: "loan-1",
      asset: USDC,
      amount: D("100"),
      price: D("1"),
    });
    expect(portfolio.getDebt("loan-1")?.principal.toString()).toBe("300");
    expect(portfolio.cash.toString()).toBe("1300");
    expect(portfolio.totalValue(prices()).toString()).toBe("1000");
    portfolio.assertIdentity(prices());

    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "yield-pool", asset: USDC, amount: D("300") },
      prices()
    );
    portfolio.accrueVenueYield("yield-pool", USDC, D("120"));

    portfolio.applyVenueOrder(
      {
        kind: "harvest",
        venueId: "yield-pool",
        asset: USDC,
        debtId: "loan-1",
      },
      prices()
    );
    expect(portfolio.getDebt("loan-1")?.principal.toString()).toBe("180");
    expect(portfolio.cash.toString()).toBe("1000");
    expect(portfolio.totalValue(prices()).toString()).toBe("1120");
    portfolio.assertIdentity(prices());

    // Accrue more than remaining debt so debt closes and surplus credits cash
    portfolio.accrueVenueYield("yield-pool", USDC, D("200"));
    portfolio.applyVenueOrder(
      {
        kind: "harvest",
        venueId: "yield-pool",
        asset: USDC,
        debtId: "loan-1",
      },
      prices()
    );
    expect(portfolio.getDebt("loan-1")).toBeUndefined();
    expect(portfolio.cash.toString()).toBe("1020");
    expect(portfolio.totalValue(prices()).toString()).toBe("1320");
    portfolio.assertIdentity(prices());
  });

  it("handles zero-yield harvest and withdrawal cleanly", () => {
    const portfolio = new Portfolio(D("500"));
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "zero-pool", asset: USDC, amount: D("500") },
      prices()
    );
    portfolio.accrueVenueYield("zero-pool", USDC, D("0"));

    portfolio.applyVenueOrder(
      { kind: "harvest", venueId: "zero-pool", asset: USDC },
      prices()
    );
    expect(portfolio.cash.toString()).toBe("0");
    expect(
      portfolio
        .getVenuePosition("zero-pool", USDC)
        ?.deployedPrincipal.toString()
    ).toBe("500");

    portfolio.applyVenueOrder(
      { kind: "withdraw", venueId: "zero-pool", asset: USDC },
      prices()
    );
    expect(portfolio.cash.toString()).toBe("500");
    expect(portfolio.getVenuePosition("zero-pool", USDC)).toBeUndefined();
    expect(portfolio.venues()).toHaveLength(0);
    portfolio.assertIdentity(prices());
  });

  it("withdraws partial principal plus remaining yield, then closes on full withdrawal", () => {
    const portfolio = new Portfolio(D("1000"));
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "pool-a", asset: USDC, amount: D("500") },
      prices(),
      D("0.5")
    );
    portfolio.accrueVenueYield("pool-a", USDC, D("30"));

    // Partial withdraw of 200 principal sweeps the 30 remaining yield
    portfolio.applyVenueOrder(
      {
        kind: "withdraw",
        venueId: "pool-a",
        asset: USDC,
        amount: D("200"),
      },
      prices(),
      D("0.5")
    );
    expect(portfolio.cash.toString()).toBe("729");
    expect(portfolio.getVenuePosition("pool-a", USDC)).toEqual({
      venueId: "pool-a",
      asset: USDC,
      deployedPrincipal: D("300"),
      accruedYield: D("0"),
    });
    portfolio.assertIdentity(prices());

    // Accrue 5 more yield and withdraw remaining 300 principal
    portfolio.accrueVenueYield("pool-a", USDC, D("5"));
    portfolio.applyVenueOrder(
      { kind: "withdraw", venueId: "pool-a", asset: USDC },
      prices()
    );
    expect(portfolio.getVenuePosition("pool-a", USDC)).toBeUndefined();
    expect(portfolio.cash.toString()).toBe("1034");
    expect(portfolio.fees.toString()).toBe("1");
    expect(portfolio.totalValue(prices()).toString()).toBe("1034");
    portfolio.assertIdentity(prices());
  });

  it("preserves exact stroop accounting identity across volatile marks with open venue positions", () => {
    const portfolio = new Portfolio(D("2500.1234567"));
    portfolio.applyFill({
      asset: EURC,
      size: D("100.3333333"),
      price: D("1.0812345"),
      fee: D("0.05"),
    });
    portfolio.applyVenueOrder(
      {
        kind: "deploy",
        venueId: "xlm-vault",
        asset: XLM,
        amount: D("1234.5678901"),
      },
      prices("1", "1.0812345", "0.1912345"),
      D("0.01")
    );
    portfolio.accrueVenueYield("xlm-vault", XLM, D("45.6789012"));

    for (const mark of [
      prices("1", "1.05", "0.18"),
      prices("1", "1.12", "0.27"),
      prices("1", "0.99", "0.2134567"),
    ]) {
      portfolio.assertIdentity(mark);
    }

    portfolio.applyVenueOrder(
      {
        kind: "withdraw",
        venueId: "xlm-vault",
        asset: XLM,
        amount: D("500"),
      },
      prices("1", "1.12", "0.25")
    );
    portfolio.assertIdentity(prices("1", "1.12", "0.25"));
  });

  it("prevents venue orders from being typed or applied as spot fills", () => {
    const deployOrder: VenueOrder = {
      kind: "deploy",
      venueId: "pool-a",
      asset: USDC,
      amount: D("100"),
    };
    const spotOrder: Order = { asset: USDC, size: D("100") };

    expect(isVenueOrder(deployOrder)).toBe(true);
    expect(isVenueOrder(spotOrder)).toBe(false);

    const acceptSpotOnly = (_order: Order): void => undefined;
    // @ts-expect-error VenueOrder has size?: never and kind !== "spot"
    acceptSpotOnly(deployOrder);

    const portfolio = new Portfolio(D("1000"));
    expect(() => portfolio.applyFill(deployOrder as unknown as Fill)).toThrow(
      InvalidFillError
    );
  });

  it("validates invalid venue and debt operations cleanly", () => {
    const portfolio = new Portfolio(D("100"));
    const ledger = portfolio.venueLedger;

    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "deploy", venueId: "  ", asset: USDC, amount: D("10") },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      portfolio.applyVenueOrder(
        {
          kind: "deploy",
          venueId: "venue",
          asset: USDC,
          amount: D("10"),
          memberId: " ",
        },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);

    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "deploy", venueId: "v", asset: USDC, amount: D("0") },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);

    expect(() =>
      portfolio.applyVenueOrder(
        {
          kind: "deploy",
          venueId: "v",
          asset: "DOGE" as AssetSymbol,
          amount: D("10"),
        },
        prices()
      )
    ).toThrow(UnknownAssetError);

    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "deploy", venueId: "v", asset: USDC, amount: D("10") },
        prices(),
        D("-1")
      )
    ).toThrow(InvalidFillError);

    expect(() => portfolio.accrueVenueYield("missing", USDC, D("1"))).toThrow(
      InvalidVenueOperationError
    );

    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "v", asset: USDC, amount: D("50") },
      prices()
    );
    expect(() => portfolio.accrueVenueYield("v", USDC, D("-1"))).toThrow(
      InvalidVenueOperationError
    );
    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "harvest", venueId: "v", asset: USDC, amount: D("1") },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "harvest", venueId: "v", asset: USDC, debtId: "missing" },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "withdraw", venueId: "v", asset: USDC, amount: D("60") },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);

    expect(() =>
      portfolio.openDebt({
        debtId: " ",
        asset: USDC,
        amount: D("10"),
        price: D("1"),
      })
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      portfolio.openDebt({
        debtId: "d1",
        asset: USDC,
        amount: D("0"),
        price: D("1"),
      })
    ).toThrow(InvalidVenueOperationError);
    portfolio.openDebt({
      debtId: "d1",
      asset: EURC,
      amount: D("10"),
      price: D("1"),
    });
    expect(() =>
      portfolio.openDebt({
        debtId: "d1",
        asset: USDC,
        amount: D("10"),
        price: D("1"),
      })
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      portfolio.applyVenueOrder(
        { kind: "harvest", venueId: "v", asset: USDC, debtId: "d1" },
        prices()
      )
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      ledger.harvest({ kind: "harvest", venueId: "v", asset: USDC }, D("-1"))
    ).toThrow(InvalidVenueOperationError);
    expect(() =>
      ledger.withdraw({ kind: "withdraw", venueId: "v", asset: USDC }, D("-1"))
    ).toThrow(InvalidVenueOperationError);
    portfolio.applyVenueOrder(
      {
        kind: "deploy",
        venueId: "v",
        asset: USDC,
        amount: D("10"),
        memberId: "alpha",
      },
      prices()
    );
    expect(portfolio.getVenuePosition("v", USDC, "alpha")?.memberId).toBe(
      "alpha"
    );
    expect(portfolio.venues().some((pos) => pos.memberId === "alpha")).toBe(
      true
    );
    expect(() => portfolio.totalValue(new Map())).toThrow(UnknownAssetError);
    expect(() => portfolio.unrealized(new Map())).toThrow(UnknownAssetError);
  });

  it("rejects negative venue rates before mutating any accrued yield", () => {
    const portfolio = new Portfolio(D("1000"));
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "first", asset: USDC, amount: D("100") },
      prices()
    );
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "second", asset: USDC, amount: D("100") },
      prices()
    );

    expect(() =>
      portfolio.venueLedger.accrueTick(
        1_000,
        {
          first: { ratePerSecond: D("0.01") },
          second: { ratePerSecond: D("-0.01") },
        },
        {}
      )
    ).toThrow(InvalidVenueOperationError);
    expect(
      portfolio.getVenuePosition("first", USDC)?.accruedYield.toString()
    ).toBe("0");
    expect(
      portfolio.getVenuePosition("second", USDC)?.accruedYield.toString()
    ).toBe("0");
  });

  it("discards fractional accrual remainders when a venue position closes", () => {
    const portfolio = new Portfolio(D("10"));
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "fractional", asset: USDC, amount: D("1") },
      prices()
    );
    const rates = { fractional: { ratePerSecond: D("0.0000001") } };
    const remainders = portfolio.venueLedger.accrueTick(1, rates, {});
    expect(
      Object.keys(remainders).some((key) => key.startsWith("venue:"))
    ).toBe(true);

    portfolio.applyVenueOrder(
      { kind: "withdraw", venueId: "fractional", asset: USDC },
      prices()
    );
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "fractional", asset: USDC, amount: D("1") },
      prices()
    );
    const afterClose = portfolio.venueLedger.accrueTick(999, rates, remainders);
    expect(
      Object.keys(afterClose).some((key) => key.startsWith("venue:"))
    ).toBe(true);
    expect(
      portfolio.getVenuePosition("fractional", USDC)?.accruedYield.toString()
    ).toBe("0");
  });

  it("carries fractional venue yield across ticks and accrues the exact amount", () => {
    const portfolio = new Portfolio(D("10"));
    portfolio.applyVenueOrder(
      { kind: "deploy", venueId: "fractional", asset: USDC, amount: D("1") },
      prices()
    );
    const rates = { fractional: { ratePerSecond: D("0.0000001") } };
    let remainders: Readonly<Record<string, bigint>> = {};

    for (let tick = 0; tick < 1_000; tick += 1) {
      remainders = portfolio.venueLedger.accrueTick(1, rates, remainders);
    }

    expect(
      portfolio.getVenuePosition("fractional", USDC)?.accruedYield.toString()
    ).toBe("0.0000001");
  });
});

describe("runBacktest with venue orders and yield accrual (#1250)", () => {
  it("executes deploy, yield accrual, harvest, and close withdraw in tick order", () => {
    const observedPositions: string[] = [];

    const strategy: VenueStrategy<null> = {
      name: "venue-yield-strategy",
      init: () => undefined,
      step: (ctx: StrategyContext) => {
        const pos = ctx.venues?.getVenuePosition("savings-venue", USDC);
        observedPositions.push(
          pos
            ? `${pos.deployedPrincipal.toString()}+${pos.accruedYield.toString()}`
            : "none"
        );
      },
      rebalance: (ctx: StrategyContext): readonly EngineOrder[] => {
        const pos = ctx.venues?.getVenuePosition("savings-venue", USDC);
        if (!pos) {
          return [
            {
              kind: "deploy",
              venueId: "savings-venue",
              asset: USDC,
              amount: D("1000"),
            },
          ];
        }
        if (pos.accruedYield.toStroops() > 0n) {
          return [
            {
              kind: "harvest",
              venueId: "savings-venue",
              asset: USDC,
            },
          ];
        }
        return [];
      },
      close: (ctx: StrategyContext): readonly EngineOrder[] => {
        const pos = ctx.venues?.getVenuePosition("savings-venue", USDC);
        if (!pos) return [];
        return [
          {
            kind: "withdraw",
            venueId: "savings-venue",
            asset: USDC,
          },
        ];
      },
    };

    const clock = new SimulationClock({
      start: START,
      end: START + 2 * ONE_HOUR_MS,
      stepMs: ONE_HOUR_MS,
    });
    const feed = BacktestPriceFeed.create({
      USDC: [
        { timestamp: START, price: "1" },
        { timestamp: START + ONE_HOUR_MS, price: "1" },
        { timestamp: START + 2 * ONE_HOUR_MS, price: "1" },
      ],
    });

    // 0.00001 per second * 3600s = 0.036 per hour -> 36 USDC yield per hour on 1000 USDC
    const result = runBacktest({
      clock,
      assets: [USDC],
      prices: feed,
      strategy,
      strategyConfig: null,
      initialCash: D("1000"),
      accrual: {
        venueRates: {
          "savings-venue": { ratePerSecond: D("0.00001") },
        },
      },
    });

    expect(observedPositions).toEqual(["none", "1000+36", "1000+36"]);
    expect(result.snapshots[0]?.venues).toHaveLength(1);
    expect(result.snapshots[0]?.value.toString()).toBe("1000");
    expect(result.snapshots[1]?.value.toString()).toBe("1036");
    expect(result.snapshots[2]?.value.toString()).toBe("1072");
    expect(result.finalValue.toString()).toBe("1072");
    expect(serializeSnapshots(result.snapshots)).toContain("savings-venue");
  });

  it("accrues annualized venue rates with remainder carry and interleaves spot fills in order", () => {
    const strategy: VenueStrategy<null> = {
      name: "interleaved",
      init: () => undefined,
      step: () => undefined,
      rebalance: (ctx: StrategyContext): readonly EngineOrder[] => {
        if (ctx.market.timestamp === START) {
          // Sell spot or buy spot + deploy in the same tick
          return [
            { asset: EURC, size: D("100") },
            {
              kind: "deploy",
              venueId: "annual-venue",
              asset: USDC,
              amount: D("500"),
            },
          ];
        }
        return [];
      },
      close: (): readonly EngineOrder[] => [
        { asset: EURC, size: D("-100") },
        { kind: "withdraw", venueId: "annual-venue", asset: USDC },
      ],
    };

    const clock = new SimulationClock({
      start: START,
      end: START + 2 * ONE_HOUR_MS,
      stepMs: ONE_HOUR_MS,
    });
    const feed = BacktestPriceFeed.create({
      USDC: [
        { timestamp: START, price: "1" },
        { timestamp: START + 2 * ONE_HOUR_MS, price: "1" },
      ],
      EURC: [
        { timestamp: START, price: "1" },
        { timestamp: START + 2 * ONE_HOUR_MS, price: "1.05" },
      ],
    });

    const result = runBacktest({
      clock,
      assets: [USDC, EURC],
      prices: feed,
      strategy,
      strategyConfig: null,
      initialCash: D("1000"),
      accrual: {
        venueRates: {
          "annual-venue": { annualRate: D("0.10") },
        },
      },
    });

    // 100 EURC gained +5 USDC, plus 2 hours of 10% APY on 500 USDC (> 0 stroops)
    expect(result.finalValue.toStroops()).toBeGreaterThan(
      D("1005").toStroops()
    );

    // Unpriced venue asset and unconfigured venue rate branches
    const badAssetStrategy: VenueStrategy<null> = {
      name: "bad-asset",
      init: () => undefined,
      step: () => undefined,
      rebalance: () => [
        { kind: "deploy", venueId: "unrated", asset: EURC, amount: D("10") },
      ],
      close: () => [],
    };
    expect(() =>
      runBacktest({
        clock,
        assets: [USDC],
        prices: feed,
        strategy: badAssetStrategy,
        strategyConfig: null,
        initialCash: D("100"),
      })
    ).toThrow(RangeError);
  });
});
