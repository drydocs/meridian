import { describe, expect, it } from "vitest";
import { applyOperationCosts, fixed, ZERO_COST_SCHEDULE } from "./cost-model";

describe("applyOperationCosts", () => {
  it("applies swap, borrow, and network costs to the net result", () => {
    const result = applyOperationCosts(
      {
        grossResult: fixed("1000"),
        swapNotional: fixed("1000"),
        borrowedNotional: fixed("500"),
        networkOperations: 2n,
      },
      {
        swapFeeRate: fixed("0.003"),
        borrowSpreadRate: fixed("0.01"),
        networkFeePerOperation: fixed("0.5"),
      },
    );

    expect(result.swapFee.toString()).toBe("3");
    expect(result.borrowSpread.toString()).toBe("5");
    expect(result.networkFee.toString()).toBe("1");
    expect(result.netResult.toString()).toBe("991");
  });

  it("preserves the pre-cost result with a zero-cost schedule", () => {
    const grossResult = fixed("12.3456789");
    const result = applyOperationCosts({ grossResult, networkOperations: 99n }, ZERO_COST_SCHEDULE);
    expect(result.netResult.raw).toBe(grossResult.raw);
  });
});
