import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import {
  LiquidationEngine,
  type LeveragedPosition,
  type LiquidationBook,
  type LiquidationEvent,
} from "./liquidation";
import { LiquidationParameterModel } from "./models/liquidation-parameter";
import { StaticPriceFeed } from "./feeds";
import { FixedPointDecimal, type SimulationTimestamp } from "./types";

/** Liquidation boundary at a health factor of 1.0 once collateral is discounted. */
const model = new LiquidationParameterModel(
  Decimal.fromString("0.5"),
  Decimal.fromString("0.8"),
  Decimal.fromString("0.05")
);

/** The same parameters with no penalty, so a seizure covers the debt exactly. */
const noPenaltyModel = new LiquidationParameterModel(
  Decimal.fromString("0.5"),
  Decimal.fromString("0.8"),
  Decimal.zero()
);

const timestamp: SimulationTimestamp = 1_000;
const feed = StaticPriceFeed.create({ USDC: "1.0", EURC: "1.1" });
const flatFeed = StaticPriceFeed.create({ USDC: "1.0", EURC: "1.0" });

const position = (
  overrides: Partial<LeveragedPosition> = {}
): LeveragedPosition => ({
  id: "pos-1",
  collateralAsset: "EURC",
  collateralAmount: FixedPointDecimal.fromString("100"),
  debtAsset: "USDC",
  debtAmount: FixedPointDecimal.fromString("50"),
  ...overrides,
});

const book = (
  positions: LeveragedPosition[],
  realizedLosses = "0"
): LiquidationBook => ({
  positions: new Map(positions.map((entry) => [entry.id, entry] as const)),
  realizedLosses: FixedPointDecimal.fromString(realizedLosses),
});

/**
 * `FixedPointDecimal` holds its value in a private field, so `toEqual` cannot
 * compare two of them and would accept any amount. Project to strings instead.
 */
const amounts = (event: LiquidationEvent) => ({
  positionId: event.positionId,
  timestamp: event.timestamp,
  healthFactor: event.healthFactor.toString(),
  debtCleared: event.debtCleared.toString(),
  collateralSeized: event.collateralSeized.toString(),
  realizedLoss: event.realizedLoss.toString(),
});

const held = (entry: LeveragedPosition | undefined) => ({
  collateralAmount: entry?.collateralAmount.toString(),
  debtAmount: entry?.debtAmount.toString(),
});

const engineWith = (priceFeed = feed, liquidationModel = model) => {
  const emitted: LiquidationEvent[] = [];
  const engine = new LiquidationEngine(priceFeed, liquidationModel, {
    emit: (event) => emitted.push(event),
  });
  return { engine, emitted };
};

describe("LiquidationEngine", () => {
  it("computes the health factor from the liquidation parameter model", () => {
    const { engine } = engineWith();

    // Collateral of 100 EURC at 1.1 is worth 110, discounted by the 0.8
    // threshold to 88, against 50 of debt. 88 / 50 = 1.76.
    expect(engine.computeHealthFactor(position(), timestamp)?.toString()).toBe(
      "1.76"
    );
  });

  it("reports no health factor for a position carrying no debt", () => {
    const { engine, emitted } = engineWith();
    const unlevered = position({
      debtAmount: FixedPointDecimal.fromStroops(0n),
    });

    expect(engine.computeHealthFactor(unlevered, timestamp)).toBeUndefined();

    const result = engine.processTick(book([unlevered]), timestamp);

    expect(result.liquidations).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("never liquidates a position that stays above the boundary", () => {
    const { engine, emitted } = engineWith();

    const result = engine.processTick(book([position()]), timestamp);

    expect(result.liquidations).toEqual([]);
    expect(emitted).toEqual([]);
    expect(held(result.book.positions.get("pos-1"))).toEqual({
      collateralAmount: "100",
      debtAmount: "50",
    });
  });

  it("leaves a position sitting exactly on the boundary and liquidates just below it", () => {
    const { engine, emitted } = engineWith(flatFeed);
    const onBoundary = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("125"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    // 125 * 0.8 / 100 is exactly 1.0, which is safe.
    expect(engine.computeHealthFactor(onBoundary, timestamp)?.toString()).toBe(
      "1"
    );
    expect(
      engine.processTick(book([onBoundary]), timestamp).liquidations
    ).toEqual([]);
    expect(emitted).toEqual([]);

    const justBelow = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("124"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });
    const result = engine.processTick(book([justBelow]), timestamp);

    expect(result.liquidations.map(amounts)).toEqual([
      {
        positionId: "pos-1",
        timestamp,
        healthFactor: "0.992",
        debtCleared: "100",
        collateralSeized: "105",
        realizedLoss: "0",
      },
    ]);
    expect(emitted).toHaveLength(1);
  });

  it("seizes the debt plus the penalty when the collateral covers both", () => {
    const { engine, emitted } = engineWith(flatFeed);
    const liquidatable = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("110"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    // Health factor 0.88, so below the boundary. The 5% penalty makes the
    // required value 105, which the 110 of collateral covers, leaving 5.
    const result = engine.processTick(book([liquidatable]), timestamp);

    expect(result.liquidations.map(amounts)).toEqual([
      {
        positionId: "pos-1",
        timestamp,
        healthFactor: "0.88",
        debtCleared: "100",
        collateralSeized: "105",
        realizedLoss: "0",
      },
    ]);
    expect(emitted.map(amounts)).toEqual(result.liquidations.map(amounts));
    expect(held(result.book.positions.get("pos-1"))).toEqual({
      collateralAmount: "5",
      debtAmount: "0",
    });
    expect(result.book.realizedLosses.toString()).toBe("0");
  });

  it("writes off the debt the seized collateral cannot cover", () => {
    const { engine, emitted } = engineWith(flatFeed);
    const underwater = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("90"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    // Health factor 0.72. The penalty brings the required value to 105, so the
    // whole 90 is seized and the 10 it cannot cover is realised as a loss.
    const result = engine.processTick(book([underwater]), timestamp);

    expect(emitted.map(amounts)).toEqual([
      {
        positionId: "pos-1",
        timestamp,
        healthFactor: "0.72",
        debtCleared: "100",
        collateralSeized: "90",
        realizedLoss: "10",
      },
    ]);
    expect(held(result.book.positions.get("pos-1"))).toEqual({
      collateralAmount: "0",
      debtAmount: "0",
    });
    expect(result.book.realizedLosses.toString()).toBe("10");
  });

  it("leaves the incoming book untouched and accumulates losses across positions", () => {
    const { engine } = engineWith(flatFeed);
    const healthy = position({
      id: "pos-healthy",
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("125"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });
    const underwater = position({
      id: "pos-underwater",
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("90"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });
    const initial = book([healthy, underwater], "2.5");

    const result = engine.processTick(initial, timestamp);

    expect(result.liquidations.map(({ positionId }) => positionId)).toEqual([
      "pos-underwater",
    ]);
    expect(result.book.realizedLosses.toString()).toBe("12.5");
    expect(held(result.book.positions.get("pos-healthy"))).toEqual({
      collateralAmount: "125",
      debtAmount: "100",
    });

    // The book that was passed in still holds the original amounts.
    expect(initial.realizedLosses.toString()).toBe("2.5");
    expect(initial.positions.get("pos-underwater")).toBe(underwater);
    expect(held(underwater)).toEqual({
      collateralAmount: "90",
      debtAmount: "100",
    });
  });

  it("rejects a negative price rather than liquidating against it", () => {
    const { engine } = engineWith(
      StaticPriceFeed.create({ USDC: "1.0", EURC: "-1.1" })
    );

    expect(() => engine.processTick(book([position()]), timestamp)).toThrow(
      RangeError
    );
  });

  it("rejects a zero price rather than misreading the position", () => {
    // A zero debt price flattens the debt value, which the model reads as a
    // position carrying no debt, so it would be exempted from liquidation.
    const zeroDebt = engineWith(
      StaticPriceFeed.create({ USDC: "0", EURC: "1.1" })
    );

    expect(() =>
      zeroDebt.engine.computeHealthFactor(position(), timestamp)
    ).toThrow(RangeError);
    expect(() =>
      zeroDebt.engine.processTick(book([position()]), timestamp)
    ).toThrow(RangeError);

    // A zero collateral price flattens the collateral value instead. Both
    // public methods agree on rejecting it.
    const zeroCollateral = engineWith(
      StaticPriceFeed.create({ USDC: "1.0", EURC: "0" })
    );

    expect(() =>
      zeroCollateral.engine.computeHealthFactor(position(), timestamp)
    ).toThrow(RangeError);
    expect(() =>
      zeroCollateral.engine.processTick(book([position()]), timestamp)
    ).toThrow(RangeError);
  });

  it("reports nothing to the collector when the tick throws", () => {
    // The USDC position liquidates and the EURC price throws after it, so a
    // collector told about the first would be ahead of a tick that applied none
    // of them.
    const { engine, emitted } = engineWith(
      StaticPriceFeed.create({ USDC: "1.0", EURC: "-1.1" })
    );
    const liquidatable = position({
      id: "pos-first",
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("90"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    expect(() =>
      engine.processTick(book([liquidatable, position()]), timestamp)
    ).toThrow(RangeError);
    expect(emitted).toEqual([]);
  });

  it("records no loss when the collateral covers the debt", () => {
    const { engine } = engineWith(
      StaticPriceFeed.create({ USDC: "3.0", EURC: "1.0" }),
      noPenaltyModel
    );
    // 34 units at 3.0 is 102 of value against 100 of debt, so the position is
    // covered. The seizure of 100 / 3 still divides unevenly, and the residue
    // is rounding rather than debt nobody paid.
    const covered = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("34"),
      debtAsset: "EURC",
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    const result = engine.processTick(book([covered]), timestamp);

    expect(result.liquidations.map(amounts)).toEqual([
      {
        positionId: "pos-1",
        timestamp,
        healthFactor: "0.816",
        debtCleared: "100",
        collateralSeized: "33.3333333",
        realizedLoss: "0",
      },
    ]);
    expect(result.book.realizedLosses.toString()).toBe("0");
  });

  it("books the loss from values rather than from amounts", () => {
    const { engine } = engineWith(
      StaticPriceFeed.create({ USDC: "2.0", EURC: "1.0" }),
      noPenaltyModel
    );
    // 40 units at 2.0 is 80 of value against 100 of debt, so the position is 20
    // short. Read as an amount rather than a value, the 40 would book a 60
    // shortfall against the debt instead.
    const short = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("40"),
      debtAsset: "EURC",
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    const result = engine.processTick(book([short]), timestamp);

    expect(result.liquidations.map(amounts)).toEqual([
      {
        positionId: "pos-1",
        timestamp,
        healthFactor: "0.64",
        debtCleared: "100",
        collateralSeized: "40",
        realizedLoss: "20",
      },
    ]);
    expect(result.book.realizedLosses.toString()).toBe("20");
  });

  it("seizes an amount rather than a value and rounds half-up", () => {
    const { engine } = engineWith(
      StaticPriceFeed.create({ USDC: "7.0", EURC: "1.0" }),
      noPenaltyModel
    );
    // 15 units at 7.0 is 105 of value against 100 of debt. The seizure of
    // 100 / 7 is an amount of 14.28571428..., which is neither the 100 of value
    // it covers nor the 14.2857142 truncation would give.
    const uneven = position({
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("15"),
      debtAsset: "EURC",
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    const result = engine.processTick(book([uneven]), timestamp);

    expect(result.liquidations.map(amounts)).toEqual([
      {
        positionId: "pos-1",
        timestamp,
        healthFactor: "0.84",
        debtCleared: "100",
        collateralSeized: "14.2857143",
        realizedLoss: "0",
      },
    ]);
    expect(held(result.book.positions.get("pos-1"))).toEqual({
      collateralAmount: "0.7142857",
      debtAmount: "0",
    });
  });

  it("accumulates the losses from two liquidations in one tick", () => {
    const { engine, emitted } = engineWith(flatFeed);
    const first = position({
      id: "pos-a",
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("80"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });
    const second = position({
      id: "pos-b",
      collateralAsset: "USDC",
      collateralAmount: FixedPointDecimal.fromString("95"),
      debtAmount: FixedPointDecimal.fromString("100"),
    });

    // Both are underwater, so each seizes all it holds and writes off the
    // shortfall, 20 and 5 respectively.
    const result = engine.processTick(book([first, second]), timestamp);

    expect(result.liquidations.map(({ positionId }) => positionId)).toEqual([
      "pos-a",
      "pos-b",
    ]);
    expect(emitted.map(amounts)).toEqual(result.liquidations.map(amounts));
    expect(result.book.realizedLosses.toString()).toBe("25");
    expect(held(result.book.positions.get("pos-a"))).toEqual({
      collateralAmount: "0",
      debtAmount: "0",
    });
    expect(held(result.book.positions.get("pos-b"))).toEqual({
      collateralAmount: "0",
      debtAmount: "0",
    });
  });
});
