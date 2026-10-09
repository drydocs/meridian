import { describe, it, expect } from "vitest";
import { FixedPointDecimal } from "./types";
import { CostSchedule, ZERO_COSTS } from "./costs";
import {
  ZeroSlippageModel,
  ZERO_SLIPPAGE_MODEL,
  FixedBpsSlippageModel,
  SizeProportionalSlippageModel,
  applyOrderFill,
} from "./slippage-model";

describe("ZeroSlippageModel", () => {
  it("returns zero slippage for both buy and sell", () => {
    const model = new ZeroSlippageModel();
    const qty = FixedPointDecimal.fromString("10");
    const mid = FixedPointDecimal.fromString("1");

    expect(model.name).toBe("zero");
    expect(model.computeSlippageRate("buy", qty, mid).toStroops()).toBe(0n);
    expect(model.computeSlippageRate("sell", qty, mid).toStroops()).toBe(0n);
  });
});

describe("FixedBpsSlippageModel", () => {
  it("applies fixed basis points rate accurately", () => {
    // 5 bps = 0.0005 = 5,000 stroops
    const model = new FixedBpsSlippageModel(5);
    const qty = FixedPointDecimal.fromString("100");
    const mid = FixedPointDecimal.fromString("1.5");

    const rate = model.computeSlippageRate("buy", qty, mid);
    expect(rate.toStroops()).toBe(5_000n);
    expect(rate.toString()).toBe("0.0005");
  });

  it("supports bigint bps and larger rates", () => {
    // 50 bps = 0.0050 = 50,000 stroops
    const model = new FixedBpsSlippageModel(50n);
    const qty = FixedPointDecimal.fromString("10");
    const mid = FixedPointDecimal.fromString("2.0");

    const rate = model.computeSlippageRate("sell", qty, mid);
    expect(rate.toStroops()).toBe(50_000n);
    expect(rate.toString()).toBe("0.005");
  });

  it("throws on negative basis points", () => {
    expect(() => new FixedBpsSlippageModel(-1)).toThrow(RangeError);
  });
});

describe("SizeProportionalSlippageModel", () => {
  it("scales slippage linearly with quantity", () => {
    const model = new SizeProportionalSlippageModel({
      baseBps: 5, // 5 bps base
      impactBps: 20, // 20 bps dynamic impact per reference volume
      referenceVolume: FixedPointDecimal.fromString("1000"),
    });

    const mid = FixedPointDecimal.fromString("1.0");

    // Zero quantity yields base rate (5 bps = 5,000 stroops)
    const zeroRate = model.computeSlippageRate(
      "buy",
      FixedPointDecimal.fromString("0"),
      mid
    );
    expect(zeroRate.toStroops()).toBe(5_000n);

    // Half reference volume (500) -> 5 + (500/1000)*20 = 15 bps (15,000 stroops)
    const halfRate = model.computeSlippageRate(
      "buy",
      FixedPointDecimal.fromString("500"),
      mid
    );
    expect(halfRate.toStroops()).toBe(15_000n);
    expect(halfRate.toString()).toBe("0.0015");

    // Full reference volume (1000) -> 5 + (1000/1000)*20 = 25 bps (25,000 stroops)
    const fullRate = model.computeSlippageRate(
      "sell",
      FixedPointDecimal.fromString("1000"),
      mid
    );
    expect(fullRate.toStroops()).toBe(25_000n);
    expect(fullRate.toString()).toBe("0.0025");
  });

  it("rejects invalid configuration inputs", () => {
    expect(
      () =>
        new SizeProportionalSlippageModel({
          baseBps: -1,
          impactBps: 10,
          referenceVolume: FixedPointDecimal.fromString("100"),
        })
    ).toThrow(RangeError);

    expect(
      () =>
        new SizeProportionalSlippageModel({
          baseBps: 5,
          impactBps: -10,
          referenceVolume: FixedPointDecimal.fromString("100"),
        })
    ).toThrow(RangeError);

    expect(
      () =>
        new SizeProportionalSlippageModel({
          baseBps: 5,
          impactBps: 10,
          referenceVolume: FixedPointDecimal.fromString("0"),
        })
    ).toThrow(RangeError);
  });
});

describe("applyOrderFill", () => {
  it("reproduces exact mid-price fills under zero slippage and zero fees (acceptance criteria)", () => {
    const quantity = FixedPointDecimal.fromString("100");
    const midPrice = FixedPointDecimal.fromString("1.25");

    // BUY order
    const buyResult = applyOrderFill({
      side: "buy",
      quantity,
      midPrice,
      slippageModel: ZERO_SLIPPAGE_MODEL,
      costSchedule: ZERO_COSTS,
    });

    expect(buyResult.effectivePrice.toString()).toBe("1.25");
    expect(buyResult.grossNotional.toString()).toBe("125");
    expect(buyResult.tradingFee.toStroops()).toBe(0n);
    expect(buyResult.networkFee.toStroops()).toBe(0n);
    expect(buyResult.totalCost.toStroops()).toBe(0n);
    expect(buyResult.cashFlow.toString()).toBe("-125");
    expect(buyResult.effectiveNetPrice.toString()).toBe("1.25");

    // SELL order
    const sellResult = applyOrderFill({
      side: "sell",
      quantity,
      midPrice,
      slippageModel: ZERO_SLIPPAGE_MODEL,
      costSchedule: ZERO_COSTS,
    });

    expect(sellResult.effectivePrice.toString()).toBe("1.25");
    expect(sellResult.grossNotional.toString()).toBe("125");
    expect(sellResult.tradingFee.toStroops()).toBe(0n);
    expect(sellResult.networkFee.toStroops()).toBe(0n);
    expect(sellResult.totalCost.toStroops()).toBe(0n);
    expect(sellResult.cashFlow.toString()).toBe("125");
    expect(sellResult.effectiveNetPrice.toString()).toBe("1.25");
  });

  it("applies slippage symmetrically to buy and sell fills", () => {
    // 50 bps slippage (0.005) on 100 units at $2.00
    const slippageModel = new FixedBpsSlippageModel(50);
    const quantity = FixedPointDecimal.fromString("100");
    const midPrice = FixedPointDecimal.fromString("2.0");

    // Buy: price increases by 0.5% -> 2.0 * 1.005 = 2.0100000
    const buyFill = applyOrderFill({
      side: "buy",
      quantity,
      midPrice,
      slippageModel,
    });
    expect(buyFill.effectivePrice.toString()).toBe("2.01");
    expect(buyFill.grossNotional.toString()).toBe("201");
    expect(buyFill.cashFlow.toString()).toBe("-201");

    // Sell: price decreases by 0.5% -> 2.0 * 0.995 = 1.9900000
    const sellFill = applyOrderFill({
      side: "sell",
      quantity,
      midPrice,
      slippageModel,
    });
    expect(sellFill.effectivePrice.toString()).toBe("1.99");
    expect(sellFill.grossNotional.toString()).toBe("199");
    expect(sellFill.cashFlow.toString()).toBe("199");
  });

  it("incorporates trading fees and ledger network fees into total cost", () => {
    const quantity = FixedPointDecimal.fromString("50");
    const midPrice = FixedPointDecimal.fromString("1.0");

    // 10 bps fee rate (0.0010 = 10,000 stroops), 100 stroops network fee per op
    const costSchedule: CostSchedule = {
      swapFeeRate: FixedPointDecimal.fromString("0.001"),
      borrowSpreadRate: FixedPointDecimal.fromString("0"),
      networkFee: FixedPointDecimal.fromStroops(100n),
    };

    const buy = applyOrderFill({
      side: "buy",
      quantity,
      midPrice,
      costSchedule,
      networkOperations: 2n,
    });

    // Gross = 50 * 1.0 = 50.0000000 (500_000_000 stroops)
    expect(buy.grossNotional.toString()).toBe("50");
    // Swap fee = 50 * 0.001 = 0.0500000 (500_000 stroops)
    expect(buy.tradingFee.toString()).toBe("0.05");
    // Network fee = 2 * 100 = 200 stroops = 0.0000200
    expect(buy.networkFee.toStroops()).toBe(200n);
    // Total cost = 500_200 stroops = 0.0500200
    expect(buy.totalCost.toStroops()).toBe(500_200n);
    // Cash flow = -(50 + 0.05002) = -50.05002
    expect(buy.cashFlow.toStroops()).toBe(-500_500_200n);
  });

  it("rejects non-positive order quantity or midPrice", () => {
    expect(() =>
      applyOrderFill({
        side: "buy",
        quantity: FixedPointDecimal.fromString("0"),
        midPrice: FixedPointDecimal.fromString("1.0"),
      })
    ).toThrow(RangeError);

    expect(() =>
      applyOrderFill({
        side: "sell",
        quantity: FixedPointDecimal.fromString("10"),
        midPrice: FixedPointDecimal.fromString("0"),
      })
    ).toThrow(RangeError);
  });

  it("handles extreme slippage (>100%) gracefully by flooring sell price at 0", () => {
    const extremeModel = new FixedBpsSlippageModel(15_000); // 150% slippage
    const fill = applyOrderFill({
      side: "sell",
      quantity: FixedPointDecimal.fromString("10"),
      midPrice: FixedPointDecimal.fromString("1.0"),
      slippageModel: extremeModel,
    });

    expect(fill.effectivePrice.toStroops()).toBe(0n);
    expect(fill.grossNotional.toStroops()).toBe(0n);
    expect(fill.cashFlow.toStroops()).toBe(0n);
  });
});
