import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./liquidation";
import { HealthFactorMonitor, type PositionState } from "./monitor";

describe("HealthFactorMonitor", () => {
  const liquidationModel = new LiquidationParameterModel({
    maxLoanToValue: Decimal.fromString("0.80"), // 80%
    liquidationThreshold: Decimal.fromString("0.85"), // 85%
    liquidationPenalty: Decimal.fromString("0.05"), // 5%
  });

  // Trigger HF = 1.0 + 0.20 = 1.20; restore to HF = 1.50
  const monitor = new HealthFactorMonitor({
    liquidationModel,
    safetyBuffer: Decimal.fromString("0.20"),
    targetHealthFactor: Decimal.fromString("1.50"),
  });

  describe("constructor", () => {
    it("exposes the derived trigger health factor", () => {
      expect(monitor.triggerHealthFactor.toString()).toBe("1.2000000");
      expect(monitor.targetHealthFactor.toString()).toBe("1.5000000");
      expect(monitor.safetyBuffer.toString()).toBe("0.2000000");
    });

    it("rejects a negative safety buffer", () => {
      expect(
        () =>
          new HealthFactorMonitor({
            liquidationModel,
            safetyBuffer: Decimal.fromString("-0.01"),
            targetHealthFactor: Decimal.fromString("1.50"),
          })
      ).toThrowError(RangeError);
    });

    it("rejects a target health factor at or below the trigger", () => {
      // trigger is 1.20; target must be strictly greater
      expect(
        () =>
          new HealthFactorMonitor({
            liquidationModel,
            safetyBuffer: Decimal.fromString("0.20"),
            targetHealthFactor: Decimal.fromString("1.15"),
          })
      ).toThrowError(RangeError);

      expect(
        () =>
          new HealthFactorMonitor({
            liquidationModel,
            safetyBuffer: Decimal.fromString("0.20"),
            targetHealthFactor: Decimal.fromString("1.20"),
          })
      ).toThrowError(RangeError);
    });

    it("accepts a zero safety buffer with a target above 1.0", () => {
      const tight = new HealthFactorMonitor({
        liquidationModel,
        safetyBuffer: Decimal.zero(),
        targetHealthFactor: Decimal.fromString("1.01"),
      });
      expect(tight.triggerHealthFactor.toString()).toBe("1.0000000");
    });
  });

  describe("computeHealthFactor", () => {
    it("computes HF = collateral value * threshold / debt", () => {
      // (1000 * 1.00 * 0.85) / 500 = 1.70
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.fromString("500.00"),
      };
      expect(monitor.computeHealthFactor(position)?.toString()).toBe(
        "1.7000000"
      );
    });

    it("returns undefined for a debt-free position", () => {
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.zero(),
      };
      expect(monitor.computeHealthFactor(position)).toBeUndefined();
    });
  });

  describe("evaluate / processTick: no-op paths", () => {
    it("does nothing when the position is comfortably above the buffer", () => {
      // HF = (1000 * 0.85) / 500 = 1.70 > 1.20 trigger
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.fromString("500.00"),
      };

      const result = monitor.processTick(position);
      expect(result.decision.shouldDeleverage).toBe(false);
      expect(result.decision.requiredDebtRepayment.isZero()).toBe(true);
      expect(result.decision.requiredCollateralToSell.isZero()).toBe(true);
      expect(result.decision.currentHealthFactor?.toString()).toBe("1.7000000");
      expect(result.updatedPosition.debt.toString()).toBe("500.0000000");
      expect(result.updatedPosition.collateralAmount.toString()).toBe(
        "1000.0000000"
      );
      expect(result.isLiquidatedByEngine).toBe(false);
    });

    it("does nothing exactly at the trigger health factor (boundary)", () => {
      // HF = (1000 * 0.85) / 708.3333333 = 1.2000000 (rounded to 7 dp)
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.fromString("708.3333333"),
      };

      expect(monitor.computeHealthFactor(position)?.toString()).toBe(
        "1.2000000"
      );

      const result = monitor.processTick(position);
      expect(result.decision.shouldDeleverage).toBe(false);
      expect(result.isLiquidatedByEngine).toBe(false);
    });

    it("does nothing for a debt-free position", () => {
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.zero(),
      };

      const result = monitor.processTick(position);
      expect(result.decision.shouldDeleverage).toBe(false);
      expect(result.decision.currentHealthFactor).toBeUndefined();
      expect(result.isLiquidatedByEngine).toBe(false);
    });

    it("returns the trigger and target in every decision", () => {
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.fromString("500.00"),
      };
      const decision = monitor.evaluate(position);
      expect(decision.triggerHealthFactor.toString()).toBe("1.2000000");
      expect(decision.targetHealthFactor.toString()).toBe("1.5000000");
    });
  });

  describe("evaluate / processTick: breach and recovery", () => {
    it("sizes the deleverage orders with hand-worked figures", () => {
      // Price drops to $0.65 -> value $650, debt $500
      // HF = (650 * 0.85) / 500 = 1.105 (< 1.20 trigger)
      // R = (1.50 * 500 - 650 * 0.85) / (1.50 - 0.85) = 197.5 / 0.65 = 303.8461538
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("0.65"),
        debt: Decimal.fromString("500.00"),
      };

      const result = monitor.processTick(position);

      expect(result.decision.shouldDeleverage).toBe(true);
      expect(result.decision.currentHealthFactor?.toString()).toBe("1.1050000");
      expect(result.decision.requiredDebtRepayment.toString()).toBe(
        "303.8461538"
      );
      expect(result.decision.requiredCollateralToSell.toString()).toBe(
        "467.4556212"
      );

      // Collateral left: 1000 - 467.4556212 = 532.5443788
      // Debt left: 500 - 303.8461538 = 196.1538462
      expect(result.updatedPosition.collateralAmount.toString()).toBe(
        "532.5443788"
      );
      expect(result.updatedPosition.debt.toString()).toBe("196.1538462");

      // Post-deleverage HF rounds back to the 1.50 target
      const updatedHf = monitor.computeHealthFactor(result.updatedPosition);
      expect(updatedHf?.toFixed(2)).toBe("1.50");
      expect(result.isLiquidatedByEngine).toBe(false);
    });

    it("recovers: a deleveraged position is a no-op on the next tick", () => {
      const breached: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("0.65"),
        debt: Decimal.fromString("500.00"),
      };

      const first = monitor.processTick(breached);
      expect(first.decision.shouldDeleverage).toBe(true);

      const second = monitor.processTick(first.updatedPosition);
      expect(second.decision.shouldDeleverage).toBe(false);
      expect(second.decision.requiredDebtRepayment.isZero()).toBe(true);
      expect(second.isLiquidatedByEngine).toBe(false);
    });

    it("recovers: a price rebound above the trigger is a no-op", () => {
      const breached: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("0.65"),
        debt: Decimal.fromString("500.00"),
      };
      const deleveraged = monitor.processTick(breached).updatedPosition;

      // Price recovers from $0.65 back to $1.00
      const rebound: PositionState = {
        ...deleveraged,
        collateralPrice: Decimal.fromString("1.00"),
      };
      const result = monitor.processTick(rebound);
      expect(result.decision.shouldDeleverage).toBe(false);
      expect(result.isLiquidatedByEngine).toBe(false);
    });
  });

  describe("ordering versus the engine", () => {
    it("deleverages before the engine check and prevents liquidation", () => {
      // HF = (600 * 0.85) / 500 = 1.02: below trigger, above liquidation
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("0.60"),
        debt: Decimal.fromString("500.00"),
      };

      const result = monitor.processTick(position);

      expect(result.decision.shouldDeleverage).toBe(true);
      // R = (1.50 * 500 - 600 * 0.85) / (1.50 - 0.85) = 240 / 0.65 = 369.2307692
      expect(result.decision.requiredDebtRepayment.toString()).toBe(
        "369.2307692"
      );
      expect(result.updatedPosition.debt.lt(position.debt)).toBe(true);
      expect(
        result.updatedPosition.collateralAmount.lt(position.collateralAmount)
      ).toBe(true);
      expect(result.isLiquidatedByEngine).toBe(false);
      expect(
        monitor.computeHealthFactor(result.updatedPosition)?.toFixed(2)
      ).toBe("1.50");
    });

    it("rescues a position the engine alone would liquidate", () => {
      // HF = (550 * 0.85) / 500 = 0.935 < 1.0: already liquidatable
      const position: PositionState = {
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.fromString("0.55"),
        debt: Decimal.fromString("500.00"),
      };

      // Sanity: the engine, run first, would liquidate this position.
      const value = position.collateralAmount.mul(position.collateralPrice);
      expect(liquidationModel.isLiquidatable(value, position.debt)).toBe(true);

      const result = monitor.processTick(position);

      // The monitor deleverages first, and the engine then finds it safe.
      expect(result.decision.shouldDeleverage).toBe(true);
      // R = (750 - 467.5) / 0.65 = 434.6153846
      expect(result.decision.requiredDebtRepayment.toString()).toBe(
        "434.6153846"
      );
      expect(result.isLiquidatedByEngine).toBe(false);
    });

    it("clamps repayment and collateral to what the position has", () => {
      // $100 collateral vs $500 debt: repay clamps to the full debt and
      // the full collateral, leaving a zeroed-out position.
      const position: PositionState = {
        collateralAmount: Decimal.fromString("100.00"),
        collateralPrice: Decimal.fromString("1.00"),
        debt: Decimal.fromString("500.00"),
      };

      const result = monitor.processTick(position);

      expect(result.decision.shouldDeleverage).toBe(true);
      // R unclamped = (750 - 85) / 0.65 = 1023.0769... > debt -> clamped
      expect(result.decision.requiredDebtRepayment.toString()).toBe(
        "500.0000000"
      );
      // Collateral to sell unclamped = 500 / 1.00 > collateral -> clamped
      expect(result.decision.requiredCollateralToSell.toString()).toBe(
        "100.0000000"
      );
      expect(result.updatedPosition.debt.isZero()).toBe(true);
      expect(result.updatedPosition.collateralAmount.isZero()).toBe(true);
      expect(result.isLiquidatedByEngine).toBe(false);
    });
  });
});
