import { describe, it, expect } from "vitest";
import {
  BacktestPriceFeed,
  DEFAULT_REBALANCE_BAND,
  FixedPointDecimal,
  InvalidCapitalError,
  InvalidLeverageError,
  InvalidPriceError,
  InvalidRebalanceBandError,
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  StaticPriceFeed,
  StaleRebalanceOrderError,
  ZeroQuantityError,
  accrueFunding,
  applyRebalance,
  computeDelta,
  equityAfterFunding,
  isInvalidCapitalError,
  isInvalidLeverageError,
  isStaleRebalanceOrderError,
  openDeltaNeutralPosition,
  planRebalance,
  shouldRebalance,
  sizeDeltaNeutralPosition,
} from "./index";
import type {
  AssetSymbol,
  DeltaNeutralPosition,
  PriceFeed,
  RebalanceOrder,
  SimulationTimestamp,
} from "./index";

const USDC: AssetSymbol = "USDC";
const EURC: AssetSymbol = "EURC";
const BASE_TIMESTAMP: SimulationTimestamp = 1_700_000_000_000;

const d = (value: string): FixedPointDecimal =>
  FixedPointDecimal.fromString(value);

/**
 * Opens the canonical test position: 1000 USDC of margin at 2× on EURC,
 * 200 EURC long against a 2000 USDC short. At an entry price of 10 every value
 * lands on exact 7-decimal arithmetic, so the assertions below can be exact.
 */
function openPosition(
  entryPrice = "10",
  leverage = "2",
  capital = "1000",
  band?: string
): DeltaNeutralPosition {
  return openDeltaNeutralPosition({
    collateralAsset: USDC,
    riskAsset: EURC,
    capital: d(capital),
    leverage: d(leverage),
    entryPrice: d(entryPrice),
    ...(band === undefined ? {} : { rebalanceBand: d(band) }),
  });
}

/** Plan a rebalance and assert the trigger fired. */
function planOrThrow(
  position: DeltaNeutralPosition,
  spotPrice: FixedPointDecimal,
  band?: FixedPointDecimal
): RebalanceOrder {
  const order = planRebalance(position, spotPrice, band);
  if (order === null) {
    throw new Error("expected a rebalance order");
  }
  return order;
}

describe("sizeDeltaNeutralPosition", () => {
  it("scales notional and quantity across leverage levels", () => {
    const expected = [
      { leverage: "1", notional: "1000", quantity: "100" },
      { leverage: "2", notional: "2000", quantity: "200" },
      { leverage: "5", notional: "5000", quantity: "500" },
      { leverage: "10", notional: "10000", quantity: "1000" },
      { leverage: "20", notional: "20000", quantity: "2000" },
    ];

    for (const level of expected) {
      const size = sizeDeltaNeutralPosition({
        capital: d("1000"),
        leverage: d(level.leverage),
        price: d("10"),
      });

      expect(size.notional.toString()).toBe(level.notional);
      expect(size.longQuantity.toString()).toBe(level.quantity);
      expect(size.shortNotional.toString()).toBe(level.notional);
      expect(size.marginPerLeg.toString()).toBe("1000");
      expect(size.shortNotional.equals(size.notional)).toBe(true);
    }
  });

  it("accepts the inclusive leverage bounds", () => {
    const low = sizeDeltaNeutralPosition({
      capital: d("10"),
      leverage: MIN_LEVERAGE,
      price: d("2"),
    });
    const high = sizeDeltaNeutralPosition({
      capital: d("10"),
      leverage: MAX_LEVERAGE,
      price: d("2"),
    });

    expect(low.notional.toString()).toBe("10");
    expect(high.notional.toString()).toBe("200");
  });

  it("keeps fractional capital and price exact", () => {
    const size = sizeDeltaNeutralPosition({
      capital: d("1.5"),
      leverage: d("3"),
      price: d("2"),
    });

    expect(size.notional.toString()).toBe("4.5");
    expect(size.longQuantity.toString()).toBe("2.25");
    expect(size.marginPerLeg.toString()).toBe("1.5");
  });

  it("rejects leverage outside [1, 20]", () => {
    for (const leverage of ["0", "0.5", "21"]) {
      expect(() =>
        sizeDeltaNeutralPosition({
          capital: d("1000"),
          leverage: d(leverage),
          price: d("10"),
        })
      ).toThrow(InvalidLeverageError);
    }
  });

  it("reports the rejected leverage through the type guard", () => {
    try {
      sizeDeltaNeutralPosition({
        capital: d("1000"),
        leverage: d("21"),
        price: d("10"),
      });
      expect.unreachable("expected InvalidLeverageError");
    } catch (err) {
      expect(isInvalidLeverageError(err)).toBe(true);
      if (isInvalidLeverageError(err)) {
        expect(err.leverage.toString()).toBe("21");
        expect(err.minLeverage.equals(MIN_LEVERAGE)).toBe(true);
        expect(err.maxLeverage.equals(MAX_LEVERAGE)).toBe(true);
      }
    }
  });

  it("rejects non-positive capital", () => {
    expect(() =>
      sizeDeltaNeutralPosition({
        capital: d("0"),
        leverage: d("2"),
        price: d("10"),
      })
    ).toThrow(InvalidCapitalError);

    try {
      sizeDeltaNeutralPosition({
        capital: d("-1"),
        leverage: d("2"),
        price: d("10"),
      });
      expect.unreachable("expected InvalidCapitalError");
    } catch (err) {
      expect(isInvalidCapitalError(err)).toBe(true);
    }
  });

  it("rejects non-positive price", () => {
    expect(() =>
      sizeDeltaNeutralPosition({
        capital: d("1000"),
        leverage: d("2"),
        price: d("0"),
      })
    ).toThrow(InvalidPriceError);
  });

  it("throws rather than silently sizing a zero position", () => {
    expect(() =>
      sizeDeltaNeutralPosition({
        capital: d("0.0000001"),
        leverage: d("1"),
        price: d("100"),
      })
    ).toThrow(ZeroQuantityError);
  });
});

describe("openDeltaNeutralPosition", () => {
  it("opens exactly neutral at the entry price", () => {
    const position = openPosition("10");
    const delta = computeDelta(position, d("10"));

    expect(position.longQuantity.toString()).toBe("200");
    expect(position.shortNotional.toString()).toBe("2000");
    expect(delta.notionalDelta.toStroops()).toBe(0n);
    expect(delta.baseDelta.toStroops()).toBe(0n);
    expect(delta.deltaRatio.toStroops()).toBe(0n);
  });

  it("stays exactly neutral when the quantity truncates", () => {
    const position = openPosition("3");
    const delta = computeDelta(position, d("3"));

    expect(position.longQuantity.toString()).toBe("666.6666666");
    expect(position.shortNotional.toString()).toBe("1999.9999998");
    expect(delta.deltaRatio.toStroops()).toBe(0n);
  });

  it("leaves well under one base stroop unhedged", () => {
    const position = openPosition("3");
    const notional = d("1000").toStroops() * 2n;
    const dust = notional - position.shortNotional.toStroops();

    // One base stroop at a price of 3 is 3e-7 quote units = 3 notional
    // stroops, so the residual must sit inside that bound.
    expect(dust).toBeGreaterThanOrEqual(0n);
    expect(dust).toBeLessThanOrEqual(3n);
  });

  it("records the configuration and applies the band default", () => {
    const position = openPosition("10");

    expect(position.collateralAsset).toBe(USDC);
    expect(position.riskAsset).toBe(EURC);
    expect(position.capital.toString()).toBe("1000");
    expect(position.leverage.toString()).toBe("2");
    expect(position.entryPrice.toString()).toBe("10");
    expect(position.rebalanceBand.equals(DEFAULT_REBALANCE_BAND)).toBe(true);
    expect(position.rebalanceBand.toString()).toBe("0.05");
  });

  it("honours an explicit rebalance band", () => {
    expect(
      openPosition("10", "2", "1000", "0.12").rebalanceBand.toString()
    ).toBe("0.12");
  });

  it("rejects a negative rebalance band", () => {
    expect(() => openPosition("10", "2", "1000", "-0.01")).toThrow(
      InvalidRebalanceBandError
    );
  });
});

describe("computeDelta", () => {
  it("returns zero exposure while the price is unchanged", () => {
    const position = openPosition("10");

    for (const price of ["10", "10.0000000"]) {
      const delta = computeDelta(position, d(price));
      expect(delta.notionalDelta.toStroops()).toBe(0n);
      expect(delta.baseDelta.toStroops()).toBe(0n);
      expect(delta.deltaRatio.toStroops()).toBe(0n);
    }
  });

  it("drifts net long as the price rises", () => {
    const delta = computeDelta(openPosition("10"), d("12.5"));

    expect(delta.notionalDelta.toString()).toBe("500");
    expect(delta.baseDelta.toString()).toBe("40");
    expect(delta.deltaRatio.toString()).toBe("0.2");
    expect(delta.notionalDelta.toStroops() > 0n).toBe(true);
  });

  it("drifts net short as the price falls", () => {
    const delta = computeDelta(openPosition("10"), d("8"));

    expect(delta.notionalDelta.toString()).toBe("-400");
    expect(delta.baseDelta.toString()).toBe("-50");
    expect(delta.deltaRatio.toString()).toBe("-0.25");
    expect(delta.notionalDelta.toStroops() < 0n).toBe(true);
  });

  it("expresses drift as a fraction of the long notional", () => {
    const position = openPosition("10");

    expect(computeDelta(position, d("10.5")).deltaRatio.toString()).toBe(
      "0.047619"
    );
    expect(computeDelta(position, d("20")).deltaRatio.toString()).toBe("0.5");
    expect(computeDelta(position, d("5")).deltaRatio.toString()).toBe("-1");
  });

  it("rejects non-positive prices", () => {
    const position = openPosition("10");

    expect(() => computeDelta(position, d("0"))).toThrow(InvalidPriceError);
    expect(() => computeDelta(position, d("-1"))).toThrow(InvalidPriceError);
  });
});

describe("shouldRebalance", () => {
  it("does not fire on a freshly opened position", () => {
    const position = openPosition("10");
    const delta = computeDelta(position, d("10"));

    expect(shouldRebalance(delta, position.rebalanceBand)).toBe(false);
  });

  it("does not fire while the drift sits inside the band", () => {
    const delta = computeDelta(openPosition("10"), d("10.5"));

    expect(delta.deltaRatio.toString()).toBe("0.047619");
    expect(shouldRebalance(delta, d("0.05"))).toBe(false);
  });

  it("fires on the positive band edge inclusively", () => {
    const delta = computeDelta(openPosition("10"), d("12.5"));

    expect(delta.deltaRatio.toString()).toBe("0.2");
    expect(shouldRebalance(delta, d("0.2"))).toBe(true);
    expect(shouldRebalance(delta, d("0.2000001"))).toBe(false);
  });

  it("does not fire just below the band edge", () => {
    const delta = computeDelta(openPosition("10"), d("12.4"));

    expect(delta.deltaRatio.toString()).toBe("0.1935483");
    expect(shouldRebalance(delta, d("0.2"))).toBe(false);
  });

  it("fires on the negative band edge inclusively", () => {
    const delta = computeDelta(openPosition("10"), d("8"));

    expect(delta.deltaRatio.toString()).toBe("-0.25");
    expect(shouldRebalance(delta, d("0.25"))).toBe(true);
    expect(shouldRebalance(delta, d("0.2500001"))).toBe(false);
  });

  it("does not fire just inside the negative band edge", () => {
    const delta = computeDelta(openPosition("10"), d("8.1"));

    expect(delta.deltaRatio.toString()).toBe("-0.2345679");
    expect(shouldRebalance(delta, d("0.25"))).toBe(false);
  });

  it("fires on any drift with a zero band", () => {
    const delta = computeDelta(openPosition("10"), d("10.1"));
    expect(shouldRebalance(delta, d("0"))).toBe(true);
  });

  it("rejects a negative band", () => {
    const delta = computeDelta(openPosition("10"), d("10"));
    expect(() => shouldRebalance(delta, d("-0.01"))).toThrow(
      InvalidRebalanceBandError
    );
  });
});

describe("planRebalance", () => {
  it("returns no order while inside the band", () => {
    expect(planRebalance(openPosition("10"), d("10.5"))).toBeNull();
    expect(planRebalance(openPosition("10"), d("10"))).toBeNull();
  });

  it("plans a sell to top up the hedge after a rally", () => {
    const order = planOrThrow(openPosition("10"), d("12.5"));

    expect(order.side).toBe("sell");
    expect(order.notional.toString()).toBe("500");
    expect(order.quantity.toString()).toBe("40");
    expect(order.deltaRatio.toString()).toBe("0.2");
  });

  it("plans a buy to trim the hedge after a sell-off", () => {
    const order = planOrThrow(openPosition("10"), d("8"));

    expect(order.side).toBe("buy");
    expect(order.notional.toString()).toBe("400");
    expect(order.quantity.toString()).toBe("50");
    expect(order.deltaRatio.toString()).toBe("-0.25");
  });

  it("honours an explicit band override", () => {
    const position = openPosition("10");

    expect(planRebalance(position, d("10.5"), d("0.1"))).toBeNull();
    expect(planRebalance(position, d("10.5"), d("0.04"))?.side).toBe("sell");
  });

  it("fires exactly on the band edge", () => {
    const order = planOrThrow(openPosition("10"), d("12.5"), d("0.2"));
    expect(order.notional.toString()).toBe("500");
  });
});

describe("applyRebalance", () => {
  it("restores neutrality at the rebalance price", () => {
    const position = openPosition("10");
    const spotPrice = d("12.5");
    const order = planOrThrow(position, spotPrice);

    const rebalanced = applyRebalance(position, order, spotPrice);
    const delta = computeDelta(rebalanced, spotPrice);

    expect(rebalanced.shortNotional.toString()).toBe("2500");
    expect(rebalanced.longQuantity.toString()).toBe(
      position.longQuantity.toString()
    );
    expect(rebalanced.capital.toString()).toBe(position.capital.toString());
    expect(delta.notionalDelta.toStroops()).toBe(0n);
    expect(delta.deltaRatio.toStroops()).toBe(0n);
  });

  it("restores neutrality after a sell-off too", () => {
    const position = openPosition("10");
    const spotPrice = d("8");
    const order = planOrThrow(position, spotPrice);

    expect(order.side).toBe("buy");

    const rebalanced = applyRebalance(position, order, spotPrice);

    expect(rebalanced.shortNotional.toString()).toBe("1600");
    expect(computeDelta(rebalanced, spotPrice).deltaRatio.toStroops()).toBe(0n);
  });

  it("triggers again once the rebalanced position drifts", () => {
    const position = openPosition("10");
    const rebalanced = applyRebalance(
      position,
      planOrThrow(position, d("12.5")),
      d("12.5")
    );

    expect(planRebalance(rebalanced, d("12.5"))).toBeNull();
    expect(planRebalance(rebalanced, d("11"))?.side).toBe("buy");
  });

  it("rejects an order planned at a different price", () => {
    const position = openPosition("10");
    const order = planOrThrow(position, d("12.5"));

    expect(() => applyRebalance(position, order, d("13"))).toThrow(
      StaleRebalanceOrderError
    );

    try {
      applyRebalance(position, order, d("13"));
      expect.unreachable("expected StaleRebalanceOrderError");
    } catch (err) {
      expect(isStaleRebalanceOrderError(err)).toBe(true);
      if (isStaleRebalanceOrderError(err)) {
        expect(err.orderNotional.toString()).toBe("500");
        expect(err.requiredNotional.toString()).toBe("600");
      }
    }
  });
});

describe("accrueFunding", () => {
  it("pays the short when the rate is positive", () => {
    const accrual = accrueFunding(openPosition("10"), d("0.0001"), 1);

    expect(accrual.notional.toString()).toBe("2000");
    expect(accrual.ratePerInterval.toString()).toBe("0.0001");
    expect(accrual.payment.toString()).toBe("0.2");
    expect(accrual.payment.toStroops() > 0n).toBe(true);
  });

  it("charges the short when the rate is negative", () => {
    const accrual = accrueFunding(openPosition("10"), d("-0.0001"), 1);

    expect(accrual.payment.toString()).toBe("-0.2");
    expect(accrual.payment.toStroops() < 0n).toBe(true);
  });

  it("flips sign strictly with the rate", () => {
    const position = openPosition("10");
    const paid = accrueFunding(position, d("0.0001"), 1);
    const charged = accrueFunding(position, d("-0.0001"), 1);

    expect(paid.payment.equals(d("0.2"))).toBe(true);
    expect(charged.payment.toString()).toBe(`-${paid.payment.toString()}`);
  });

  it("is linear in the number of intervals", () => {
    const position = openPosition("10");

    expect(accrueFunding(position, d("0.0001"), 3).payment.toString()).toBe(
      "0.6"
    );
    expect(accrueFunding(position, d("0.0001"), 30).payment.toString()).toBe(
      "6"
    );
    expect(accrueFunding(position, d("0.001"), 30).payment.toString()).toBe(
      "60"
    );
  });

  it("accrues nothing for a zero rate or zero intervals", () => {
    const position = openPosition("10");

    expect(accrueFunding(position, d("0"), 5).payment.toStroops()).toBe(0n);
    expect(accrueFunding(position, d("0.0001"), 0).payment.toStroops()).toBe(
      0n
    );
    expect(accrueFunding(position, d("0.0001"), 0).notional.toString()).toBe(
      "2000"
    );
  });

  it("accrues on the rebalanced notional", () => {
    const position = openPosition("10");
    const rebalanced = applyRebalance(
      position,
      planOrThrow(position, d("12.5")),
      d("12.5")
    );

    expect(accrueFunding(rebalanced, d("0.0001"), 24).payment.toString()).toBe(
      "6"
    );
  });

  it("rejects non-integer or negative intervals", () => {
    const position = openPosition("10");

    expect(() => accrueFunding(position, d("0.0001"), 1.5)).toThrow(RangeError);
    expect(() => accrueFunding(position, d("0.0001"), -1)).toThrow(RangeError);
  });

  it("moves equity by the signed payment", () => {
    const position = openPosition("10");
    const credit = accrueFunding(position, d("0.0001"), 3);
    const debit = accrueFunding(position, d("-0.0001"), 3);

    expect(equityAfterFunding(position, credit).toString()).toBe("1000.6");
    expect(equityAfterFunding(position, debit).toString()).toBe("999.4");
    expect(
      equityAfterFunding(
        position,
        accrueFunding(position, d("0"), 3)
      ).toString()
    ).toBe("1000");
  });
});

describe("delta-neutral scenario over a price feed", () => {
  function buildFeed(): PriceFeed {
    return BacktestPriceFeed.create({
      USDC: [
        { timestamp: BASE_TIMESTAMP, price: "1" },
        { timestamp: BASE_TIMESTAMP + 3_600_000, price: "1" },
        { timestamp: BASE_TIMESTAMP + 7_200_000, price: "1" },
      ],
      EURC: [
        { timestamp: BASE_TIMESTAMP, price: "10" },
        { timestamp: BASE_TIMESTAMP + 3_600_000, price: "10.5" },
        { timestamp: BASE_TIMESTAMP + 7_200_000, price: "12.5" },
      ],
    });
  }

  function runScenario(): Record<string, string | null> {
    const feed = buildFeed();
    const entryPrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP);
    const position = openDeltaNeutralPosition({
      collateralAsset: USDC,
      riskAsset: EURC,
      capital: d("1000"),
      leverage: d("2"),
      entryPrice,
    });

    const insideBand = planRebalance(
      position,
      feed.getSpotPrice(EURC, BASE_TIMESTAMP + 3_600_000)
    );
    const rebalancePrice = feed.getSpotPrice(EURC, BASE_TIMESTAMP + 7_200_000);
    const order = planRebalance(position, rebalancePrice);
    const rebalanced =
      order === null
        ? position
        : applyRebalance(position, order, rebalancePrice);
    const accrual = accrueFunding(rebalanced, d("0.0001"), 24);

    return {
      deltaAtOpen: computeDelta(position, entryPrice).deltaRatio.toString(),
      insideBand: insideBand === null ? null : insideBand.side,
      orderSide: order?.side ?? null,
      orderNotional: order?.notional.toString() ?? null,
      neutralAfterRebalance: computeDelta(
        rebalanced,
        rebalancePrice
      ).deltaRatio.toString(),
      fundingPayment: accrual.payment.toString(),
      equity: equityAfterFunding(rebalanced, accrual).toString(),
    };
  }

  it("walks the position through drift, trigger and funding", () => {
    expect(runScenario()).toEqual({
      deltaAtOpen: "0",
      insideBand: null,
      orderSide: "sell",
      orderNotional: "500",
      neutralAfterRebalance: "0",
      fundingPayment: "6",
      equity: "1006",
    });
  });

  it("produces identical results on every run", () => {
    expect(runScenario()).toEqual(runScenario());
  });

  it("drives the same core from a static feed", () => {
    const feed = StaticPriceFeed.create({ USDC: "1", EURC: "10" });
    const position = openDeltaNeutralPosition({
      collateralAsset: USDC,
      riskAsset: EURC,
      capital: d("1000"),
      leverage: d("2"),
      entryPrice: feed.getSpotPrice(EURC, BASE_TIMESTAMP),
    });

    expect(position.shortNotional.toString()).toBe("2000");
    expect(
      computeDelta(
        position,
        feed.getSpotPrice(EURC, BASE_TIMESTAMP + 1)
      ).deltaRatio.toStroops()
    ).toBe(0n);
  });
});
