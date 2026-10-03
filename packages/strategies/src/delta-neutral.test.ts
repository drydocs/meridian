import { describe, it, expect } from "vitest";
import { FixedPointDecimal } from "./types";
import type { AssetSymbol, SimulationTimestamp } from "./types";
import { BacktestPriceFeed } from "./feeds";
import { DeltaNeutralStrategy, StrategyLifecycleError } from "./delta-neutral";
import type {
  DeltaNeutralConfig,
  FundingBasisModel,
  FundingCapture,
  PositionSizingModel,
} from "./delta-neutral";

const USDC: AssetSymbol = "USDC";
const SCALE = 10_000_000n;

const T0: SimulationTimestamp = 1_700_000_000_000;
const STEP = 3_600_000;

const CAPITAL = FixedPointDecimal.fromString("10000");
const LEVERAGE = FixedPointDecimal.fromString("2");
const LONG_NOTIONAL = "20000";

function mul(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops((a.toStroops() * b.toStroops()) / SCALE);
}

function div(a: FixedPointDecimal, b: FixedPointDecimal): FixedPointDecimal {
  return FixedPointDecimal.fromStroops((a.toStroops() * SCALE) / b.toStroops());
}

/**
 * Test double shaped exactly like the #926 `sizePosition` model: equal long and
 * short notional, margin = notional / leverage.
 */
const sizingModel: PositionSizingModel = {
  sizePosition({ capital, targetLeverage }) {
    const longNotional = mul(capital, targetLeverage);
    return {
      longNotional,
      shortNotional: longNotional,
      marginPerLeg: div(longNotional, targetLeverage),
    };
  },
};

/** Test double shaped like the #927 term structure: 1 quote unit per tick. */
class StubFundingModel implements FundingBasisModel {
  getExpectedCapture(horizon: number): FundingCapture {
    return {
      horizon,
      funding: FixedPointDecimal.fromStroops(BigInt(horizon) * SCALE),
      basis: FixedPointDecimal.fromString("25"),
    };
  }
}

// 1.0000 → +5bps (drift inside the 50bps band) → +2% (drift leaves the band) →
// flat, so the final tick only accrues funding.
const priceFeed = BacktestPriceFeed.create({
  USDC: [
    { timestamp: T0, price: "1.0000000" },
    { timestamp: T0 + STEP, price: "1.0005000" },
    { timestamp: T0 + 2 * STEP, price: "1.0200000" },
    { timestamp: T0 + 3 * STEP, price: "1.0200000" },
  ],
  EURC: [],
});

function makeStrategy(
  overrides: Partial<DeltaNeutralConfig> = {}
): DeltaNeutralStrategy {
  return new DeltaNeutralStrategy({
    asset: USDC,
    targetLeverage: LEVERAGE,
    rebalanceBandBps: 50,
    horizonTicks: 4,
    priceFeed,
    positionSizer: sizingModel,
    fundingModel: new StubFundingModel(),
    ...overrides,
  });
}

describe("DeltaNeutralStrategy open/step/close", () => {
  it("init opens a long spot leg and an equal-notional short hedge", () => {
    const strategy = makeStrategy();
    const orders = strategy.init({ timestamp: T0, capital: CAPITAL });

    expect(orders).toHaveLength(2);
    expect(orders[0]!.book).toBe("spot");
    expect(orders[0]!.side).toBe("buy");
    expect(orders[0]!.notional.toString()).toBe(LONG_NOTIONAL);
    expect(orders[1]!.book).toBe("hedge");
    expect(orders[1]!.side).toBe("sell");
    expect(orders[1]!.notional.toString()).toBe(LONG_NOTIONAL);

    expect(strategy.isOpen).toBe(true);
    expect(strategy.spotQuantity.toString()).toBe(LONG_NOTIONAL);
    expect(strategy.hedgeQuoteNotional.toString()).toBe(LONG_NOTIONAL);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.netDeltaNotional.toStroops()).toBe(0n);
  });

  it("tracks net delta each step and accrues funding without floats", () => {
    const strategy = makeStrategy();
    strategy.init({ timestamp: T0, capital: CAPITAL });

    const orders = strategy.step({ timestamp: T0 + STEP });

    expect(orders).toHaveLength(0);
    // Price rose, so the quote-notional short is worth fewer base units and the
    // book is momentarily net long.
    expect(
      strategy.netDelta.compareTo(FixedPointDecimal.fromString("9.9"))
    ).toBe(1);
    expect(
      strategy.netDelta.compareTo(FixedPointDecimal.fromString("10.1"))
    ).toBe(-1);
    expect(
      strategy.netDeltaNotional.compareTo(FixedPointDecimal.fromString("9.9"))
    ).toBe(1);
    expect(
      strategy.netDeltaNotional.compareTo(FixedPointDecimal.fromString("10.1"))
    ).toBe(-1);

    // Neutral at entry, so the mark exactly cancels and only funding accrues.
    expect(strategy.pricePnl.toStroops()).toBe(0n);
    expect(strategy.fundingPnl.toString()).toBe("1");
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

  it("rebalances the hedge back to neutral when drift leaves the band", () => {
    const strategy = makeStrategy();
    strategy.init({ timestamp: T0, capital: CAPITAL });
    strategy.step({ timestamp: T0 + STEP });

    const orders = strategy.step({ timestamp: T0 + 2 * STEP });

    expect(orders).toHaveLength(1);
    expect(orders[0]!.book).toBe("hedge");
    expect(orders[0]!.side).toBe("sell");
    expect(
      orders[0]!.notional.compareTo(FixedPointDecimal.fromString("400"))
    ).toBe(0);

    expect(strategy.rebalanceCount).toBe(1);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.netDeltaNotional.toStroops()).toBe(0n);
    expect(strategy.hedgeQuoteNotional.toString()).toBe("20400");
    // The drift that was carried into the move is real PnL.
    expect(
      strategy.pricePnl.compareTo(FixedPointDecimal.fromString("0.19"))
    ).toBe(1);
    expect(strategy.fundingPnl.toString()).toBe("2");

    const last = strategy.deltaHistory[2]!;
    expect(last.rebalanced).toBe(true);
    expect(
      last.netDeltaNotional.compareTo(FixedPointDecimal.fromString("390"))
    ).toBe(1);
  });

  it("stays neutral on a flat tick and keeps accruing funding", () => {
    const strategy = makeStrategy();
    strategy.init({ timestamp: T0, capital: CAPITAL });
    strategy.step({ timestamp: T0 + STEP });
    strategy.step({ timestamp: T0 + 2 * STEP });

    const orders = strategy.step({ timestamp: T0 + 3 * STEP });

    expect(orders).toHaveLength(0);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.hedgeQuoteNotional.toString()).toBe("20400");
    expect(strategy.fundingPnl.toString()).toBe("3");
    expect(strategy.rebalanceCount).toBe(1);
  });

  it("close unwinds both legs and realizes the basis capture", () => {
    const strategy = makeStrategy();
    strategy.init({ timestamp: T0, capital: CAPITAL });
    strategy.step({ timestamp: T0 + STEP });
    strategy.step({ timestamp: T0 + 2 * STEP });
    strategy.step({ timestamp: T0 + 3 * STEP });

    const pricePnl = strategy.pricePnl;
    const orders = strategy.close({ timestamp: T0 + 3 * STEP });

    expect(orders).toHaveLength(2);
    expect(orders[0]!.book).toBe("spot");
    expect(orders[0]!.side).toBe("sell");
    expect(orders[0]!.notional.toString()).toBe("20400");
    expect(orders[1]!.book).toBe("hedge");
    expect(orders[1]!.side).toBe("buy");
    expect(orders[1]!.notional.toString()).toBe("20400");

    expect(strategy.isClosed).toBe(true);
    expect(strategy.isOpen).toBe(false);
    expect(strategy.spotQuantity.toStroops()).toBe(0n);
    expect(strategy.hedgeQuoteNotional.toStroops()).toBe(0n);
    expect(strategy.netDelta.toStroops()).toBe(0n);
    expect(strategy.basisPnl.toString()).toBe("25");

    const expectedPnl = pricePnl.toStroops() + 3n * SCALE + 25n * SCALE;
    expect(strategy.totalPnl.toStroops()).toBe(expectedPnl);
    expect(strategy.equity.toStroops()).toBe(CAPITAL.toStroops() + expectedPnl);
  });

  it("is deterministic across identical runs", () => {
    function run(): DeltaNeutralStrategy {
      const strategy = makeStrategy();
      strategy.init({ timestamp: T0, capital: CAPITAL });
      strategy.step({ timestamp: T0 + STEP });
      strategy.step({ timestamp: T0 + 2 * STEP });
      strategy.step({ timestamp: T0 + 3 * STEP });
      strategy.close({ timestamp: T0 + 3 * STEP });
      return strategy;
    }

    const a = run();
    const b = run();
    expect(a.equity.toString()).toBe(b.equity.toString());
    expect(a.deltaHistory.map((o) => o.netDelta.toString())).toEqual(
      b.deltaHistory.map((o) => o.netDelta.toString())
    );
  });

  it("enforces the lifecycle order", () => {
    const strategy = makeStrategy();
    expect(() => strategy.step({ timestamp: T0 })).toThrow(
      StrategyLifecycleError
    );

    strategy.init({ timestamp: T0, capital: CAPITAL });
    expect(() => strategy.init({ timestamp: T0, capital: CAPITAL })).toThrow(
      StrategyLifecycleError
    );

    strategy.close({ timestamp: T0 + STEP });
    expect(() => strategy.close({ timestamp: T0 + STEP })).toThrow(
      StrategyLifecycleError
    );
  });
});
