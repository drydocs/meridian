import { describe, it, expect } from "vitest";
import { FixedPointDecimal } from "./types";
import {
  applyCosts,
  ZERO_COSTS,
  CostSchedule,
  SimulatedOperation,
} from "./costs";

const FP = FixedPointDecimal.fromString.bind(FixedPointDecimal);

const standardSchedule: CostSchedule = {
  swapFeeRate: FP("0.003"), // 0.3 %
  borrowSpreadRate: FP("0.001"), // 0.1 %
  networkFee: FP("0.01"), // flat 0.01 per operation
};

describe("applyCosts", () => {
  // swap: 1000 gross, 0.3% swap fee = 3, network = 0.01 → total cost = 3.01, net = 996.99
  it("charges swap fee + network fee on a swap", () => {
    const op: SimulatedOperation = {
      type: "swap",
      notional: FP("1000"),
      grossResult: FP("1000"),
    };
    const result = applyCosts(op, standardSchedule);
    expect(result.breakdown.protocolFee.toString()).toBe("3");
    expect(result.breakdown.networkFee.toString()).toBe("0.01");
    expect(result.totalCost.toString()).toBe("3.01");
    expect(result.netResult.toString()).toBe("996.99");
  });

  // borrow: 500 notional, 0.1% spread = 0.5, network = 0.01 → total = 0.51, net = 99.49
  it("charges borrow spread + network fee on a borrow", () => {
    const op: SimulatedOperation = {
      type: "borrow",
      notional: FP("500"),
      grossResult: FP("100"),
    };
    const result = applyCosts(op, standardSchedule);
    expect(result.breakdown.protocolFee.toString()).toBe("0.5");
    expect(result.totalCost.toString()).toBe("0.51");
    expect(result.netResult.toString()).toBe("99.49");
  });

  it("charges only the network fee on repay, deposit, and withdraw", () => {
    for (const type of ["repay", "deposit", "withdraw"] as const) {
      const op: SimulatedOperation = {
        type,
        notional: FP("1000"),
        grossResult: FP("50"),
      };
      const result = applyCosts(op, standardSchedule);
      expect(result.breakdown.protocolFee.toString()).toBe("0");
      expect(result.breakdown.networkFee.toString()).toBe("0.01");
      expect(result.totalCost.toString()).toBe("0.01");
      expect(result.netResult.toString()).toBe("49.99");
    }
  });

  it("zero-cost schedule reproduces gross result exactly", () => {
    const op: SimulatedOperation = {
      type: "swap",
      notional: FP("1000"),
      grossResult: FP("42.5"),
    };
    const result = applyCosts(op, ZERO_COSTS);
    expect(result.totalCost.toString()).toBe("0");
    expect(result.netResult.toString()).toBe("42.5");
    expect(result.netResult.equals(op.grossResult)).toBe(true);
  });

  it("raised fee schedule produces lower net returns than standard", () => {
    const op: SimulatedOperation = {
      type: "swap",
      notional: FP("1000"),
      grossResult: FP("1000"),
    };
    const highFeeSchedule: CostSchedule = {
      // Every component is set above the standard schedule below.
      swapFeeRate: FP("0.01"),
      borrowSpreadRate: FP("0.005"),
      networkFee: FP("0.1"),
    };
    const standard = applyCosts(op, standardSchedule);
    const highFee = applyCosts(op, highFeeSchedule);
    expect(highFee.netResult.compareTo(standard.netResult)).toBe(-1);
  });

  it("network fee accrues linearly across multiple operations", () => {
    const ops: SimulatedOperation[] = [
      { type: "deposit", notional: FP("1000"), grossResult: FP("10") },
      { type: "swap", notional: FP("500"), grossResult: FP("5") },
      { type: "repay", notional: FP("200"), grossResult: FP("2") },
    ];
    const schedule: CostSchedule = {
      swapFeeRate: FP("0"),
      borrowSpreadRate: FP("0"),
      networkFee: FP("0.01"),
    };
    const totalNetworkFees = ops
      .map((op) => applyCosts(op, schedule).breakdown.networkFee.toStroops())
      .reduce((acc, n) => acc + n, 0n);
    // 3 ops × 0.01 = 0.03
    expect(FixedPointDecimal.fromStroops(totalNetworkFees).toString()).toBe(
      "0.03"
    );
  });
});
