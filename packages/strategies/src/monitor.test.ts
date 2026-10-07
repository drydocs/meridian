import { describe, it, expect } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";
import { HealthFactorMonitor, PositionState } from "./monitor";

describe("HealthFactorMonitor", () => {
  const liquidationModel = new LiquidationParameterModel(
    Decimal.fromString("0.80"), // 80%
    Decimal.fromString("0.85"), // 85%
    Decimal.fromString("0.05") // 5%
  );

  const monitor = new HealthFactorMonitor({
    liquidationModel,
    safetyBuffer: Decimal.fromString("0.20"), // Trigger at HF < 1.20
    targetHealthFactor: Decimal.fromString("1.50"), // Restore to HF = 1.50
  });

  it("should validate config and reject invalid target health factor", () => {
    // trigger is 1.0 + 0.20 = 1.20. Target <= 1.20 must be rejected.
    expect(
      () =>
        new HealthFactorMonitor({
          liquidationModel,
          safetyBuffer: Decimal.fromString("0.20"),
          targetHealthFactor: Decimal.fromString("1.15"),
        })
    ).toThrow(RangeError);
  });

  it("should return no-op when position is comfortably above safety buffer", () => {
    // 1000 collateral at $1.00 = $1000. Debt = $500.
    // HF = (1000 * 0.85) / 500 = 1.70 > 1.20 trigger
    const position: PositionState = {
      collateralAmount: Decimal.fromString("1000.00"),
      collateralPrice: Decimal.fromString("1.00"),
      debt: Decimal.fromString("500.00"),
    };

    const result = monitor.processTick(position);
    expect(result.decision.shouldDeleverage).toBe(false);
    expect(result.decision.requiredDebtRepayment.isZero()).toBe(true);
    expect(result.updatedPosition.debt.toString()).toBe("500.0000000");
    expect(result.isLiquidatedByEngine).toBe(false);
  });

  it("should trigger auto-deleverage on breach and restore HF to target", () => {
    // Collateral price drops to $0.65 -> Collateral Value = $650
    // Debt = $500
    // HF = (650 * 0.85) / 500 = 552.5 / 500 = 1.105 (< 1.20 trigger, but > 1.0 liquidation threshold)
    const position: PositionState = {
      collateralAmount: Decimal.fromString("1000.00"),
      collateralPrice: Decimal.fromString("0.65"),
      debt: Decimal.fromString("500.00"),
    };

    const result = monitor.processTick(position);
    expect(result.decision.shouldDeleverage).toBe(true);
    expect(result.decision.requiredDebtRepayment.gt(Decimal.zero())).toBe(true);
    expect(result.isLiquidatedByEngine).toBe(false);

    // Verify updated position health factor equals target HF (1.50)
    const updatedHf = monitor.computeHealthFactor(result.updatedPosition);
    expect(updatedHf?.toFixed(2)).toBe("1.50");
  });

  it("should execute auto-deleverage and prevent liquidation before engine check", () => {
    // Position very close to threshold: Collateral = $1000 at $0.60 = $600. Debt = $500.
    // HF = (600 * 0.85) / 500 = 510 / 500 = 1.02 (about to be liquidated)
    const position: PositionState = {
      collateralAmount: Decimal.fromString("1000.00"),
      collateralPrice: Decimal.fromString("0.60"),
      debt: Decimal.fromString("500.00"),
    };

    const result = monitor.processTick(position);
    expect(result.decision.shouldDeleverage).toBe(true);
    expect(result.isLiquidatedByEngine).toBe(false);
    expect(result.updatedPosition.debt.lt(position.debt)).toBe(true);
    expect(
      result.updatedPosition.collateralAmount.lt(position.collateralAmount)
    ).toBe(true);

    const postDeleverageHf = monitor.computeHealthFactor(
      result.updatedPosition
    );
    expect(postDeleverageHf?.toFixed(2)).toBe("1.50");
  });

  it("should reject a negative safety buffer", () => {
    expect(
      () =>
        new HealthFactorMonitor({
          liquidationModel,
          safetyBuffer: Decimal.fromString("-0.01"),
          targetHealthFactor: Decimal.fromString("1.50"),
        })
    ).toThrowError(/Safety buffer cannot be negative/);
  });

  it("should emit no deleverage for a position carrying no debt", () => {
    const result = monitor.processTick({
      collateralAmount: Decimal.fromString("1000.00"),
      collateralPrice: Decimal.fromString("0.65"),
      debt: Decimal.zero(),
    });

    expect(result.decision.shouldDeleverage).toBe(false);
    expect(result.decision.currentHealthFactor).toBeUndefined();
    expect(result.isLiquidatedByEngine).toBe(false);
  });

  it("should reject a non-positive collateral price", () => {
    expect(() =>
      monitor.processTick({
        collateralAmount: Decimal.fromString("1000.00"),
        collateralPrice: Decimal.zero(),
        debt: Decimal.fromString("500.00"),
      })
    ).toThrowError(/Collateral price must be strictly positive/);
  });

  it("should bound the repayment by what the collateral can raise", () => {
    // Collateral worth $6.50 against $500 of debt cannot reach the target, so
    // the sale proceeds bound the repayment rather than clearing the debt.
    const position: PositionState = {
      collateralAmount: Decimal.fromString("10.00"),
      collateralPrice: Decimal.fromString("0.65"),
      debt: Decimal.fromString("500.00"),
    };

    const result = monitor.processTick(position);
    expect(result.decision.shouldDeleverage).toBe(true);
    expect(result.decision.requiredDebtRepayment.toString()).toBe("6.5000000");
    expect(result.decision.requiredCollateralToSell.toString()).toBe(
      "10.0000000"
    );
    expect(result.updatedPosition.collateralAmount.isZero()).toBe(true);
    expect(result.updatedPosition.debt.toString()).toBe("493.5000000");
    expect(result.isLiquidatedByEngine).toBe(true);
  });
});
