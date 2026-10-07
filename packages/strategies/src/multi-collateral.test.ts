import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";
import {
  CollateralPosition,
  DeleverageOrder,
  MultiCollateralBasket,
} from "./multi-collateral";

const usdcModel = new LiquidationParameterModel(
  Decimal.fromString("0.80"),
  Decimal.fromString("0.85"),
  Decimal.fromString("0.05")
);

const xlmModel = new LiquidationParameterModel(
  Decimal.fromString("0.60"),
  Decimal.fromString("0.70"),
  Decimal.fromString("0.10")
);

function position(
  asset: string,
  amount: string,
  price: string,
  model: LiquidationParameterModel
): CollateralPosition {
  return {
    asset,
    amount: Decimal.fromString(amount),
    price: Decimal.fromString(price),
    liquidationModel: model,
  };
}

/** 100 USDC at $1 plus 500 XLM at $0.20, so each leg is worth $100. */
const mixedBasket: CollateralPosition[] = [
  position("USDC", "100", "1.00", usdcModel),
  position("XLM", "500", "0.20", xlmModel),
];

function sumRepaid(orders: DeleverageOrder[]): Decimal {
  return orders.reduce(
    (total, order) => total.add(order.debtRepaidValue),
    Decimal.zero()
  );
}

describe("MultiCollateralBasket", () => {
  it("rejects a basket with no positions", () => {
    expect(() => new MultiCollateralBasket({ positions: [] })).toThrow(
      RangeError
    );
  });

  it("keeps the single-collateral case identical to LiquidationParameterModel", () => {
    const sole = position("USDC", "100", "1.00", usdcModel);
    const basket = new MultiCollateralBasket({ positions: [sole] });

    expect(basket.computeTotalCollateralValue().toString()).toBe("100.0000000");
    expect(basket.computeBlendedLiquidationThreshold().toString()).toBe(
      "0.8500000"
    );
    expect(basket.computeBlendedMaxLoanToValue().toString()).toBe("0.8000000");

    const collateralValue = Decimal.fromString("100");
    const debt = Decimal.fromString("50");

    expect(basket.computeHealthFactor(debt)?.toString()).toBe(
      usdcModel.computeHealthFactor(collateralValue, debt)?.toString()
    );
    expect(basket.computeHealthFactor(debt)?.toString()).toBe("1.7000000");
  });

  it("blends a multi-asset basket by value", () => {
    // $100 USDC discounts to $85 at 85%, $100 XLM to $70 at 70%, so the
    // discounted total is $155 over $200 of collateral.
    const basket = new MultiCollateralBasket({ positions: mixedBasket });

    expect(basket.computeTotalCollateralValue().toString()).toBe("200.0000000");
    expect(basket.computeBlendedLiquidationThreshold().toString()).toBe(
      "0.7750000"
    );
    expect(basket.computeBlendedMaxLoanToValue().toString()).toBe("0.7000000");
    expect(
      basket.computeHealthFactor(Decimal.fromString("100"))?.toString()
    ).toBe("1.5500000");
  });

  it("weights the blended figures by position value rather than position count", () => {
    // The XLM leg is worth a tenth of the USDC leg, so the blend sits next to
    // USDC's 85% rather than halfway to XLM's 70%.
    const basket = new MultiCollateralBasket({
      positions: [
        position("USDC", "100", "1.00", usdcModel),
        position("XLM", "50", "0.20", xlmModel),
      ],
    });

    expect(basket.computeBlendedLiquidationThreshold().toString()).toBe(
      "0.8363636"
    );
    expect(basket.computeBlendedMaxLoanToValue().toString()).toBe("0.7818182");
  });

  it("returns a zero threshold, loan-to-value and empty plan for a valueless basket", () => {
    const basket = new MultiCollateralBasket({
      positions: [position("ZERO", "0", "0", usdcModel)],
    });

    expect(basket.computeTotalCollateralValue().isZero()).toBe(true);
    expect(basket.computeBlendedLiquidationThreshold().isZero()).toBe(true);
    expect(basket.computeBlendedMaxLoanToValue().isZero()).toBe(true);
    expect(basket.computeDeleveragePlan(Decimal.fromString("10"))).toEqual([]);
  });

  it("returns an undefined health factor when there is no debt", () => {
    const basket = new MultiCollateralBasket({ positions: mixedBasket });

    expect(basket.computeHealthFactor(Decimal.zero())).toBeUndefined();
  });

  it("rejects a negative debt or a negative price", () => {
    const basket = new MultiCollateralBasket({ positions: mixedBasket });

    expect(() => basket.computeHealthFactor(Decimal.fromString("-1"))).toThrow(
      RangeError
    );

    const negativePrice = new MultiCollateralBasket({
      positions: [position("XLM", "500", "-0.20", xlmModel)],
    });

    expect(() => negativePrice.computeHealthFactor(Decimal.one())).toThrow(
      /Price for XLM cannot be negative/
    );

    const negativeAmount = new MultiCollateralBasket({
      positions: [position("XLM", "-500", "0.20", xlmModel)],
    });

    expect(() => negativeAmount.computeHealthFactor(Decimal.one())).toThrow(
      /Collateral amount for XLM cannot be negative/
    );
  });

  describe("deleverage plans", () => {
    it("returns no orders for a request of zero or less", () => {
      const basket = new MultiCollateralBasket({ positions: mixedBasket });

      expect(basket.computeDeleveragePlan(Decimal.zero())).toEqual([]);
      expect(basket.computeDeleveragePlan(Decimal.fromString("-10"))).toEqual(
        []
      );
    });

    it("unwinds the lowest liquidation threshold first", () => {
      const basket = new MultiCollateralBasket({
        positions: mixedBasket,
        deleveragePolicy: "highest-risk-first",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));

      expect(plan).toHaveLength(1);
      expect(plan[0]!.asset).toBe("XLM");
      expect(plan[0]!.amountToUnwind.toString()).toBe("250.0000000");
      expect(plan[0]!.debtRepaidValue.toString()).toBe("50.0000000");
    });

    it("exhausts one position before drawing on the next", () => {
      const basket = new MultiCollateralBasket({
        positions: mixedBasket,
        deleveragePolicy: "highest-risk-first",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("150"));

      expect(plan.map((order) => order.asset)).toEqual(["XLM", "USDC"]);
      expect(plan[0]!.amountToUnwind.toString()).toBe("500.0000000");
      expect(plan[0]!.debtRepaidValue.toString()).toBe("100.0000000");
      expect(plan[1]!.amountToUnwind.toString()).toBe("50.0000000");
      expect(plan[1]!.debtRepaidValue.toString()).toBe("50.0000000");
    });

    it("unwinds the lowest liquidity penalty first", () => {
      const basket = new MultiCollateralBasket({
        positions: mixedBasket,
        deleveragePolicy: "lowest-liquidity-penalty-first",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));

      expect(plan.map((order) => order.asset)).toEqual(["USDC"]);
      expect(plan[0]!.amountToUnwind.toString()).toBe("50.0000000");
    });

    it("breaks a policy tie by asset rather than by input order", () => {
      const tied = [
        position("ZZZ", "100", "1.00", usdcModel),
        position("AAA", "100", "1.00", usdcModel),
      ];

      const forward = new MultiCollateralBasket({
        positions: tied,
        deleveragePolicy: "highest-risk-first",
      });
      const reversed = new MultiCollateralBasket({
        positions: [...tied].reverse(),
        deleveragePolicy: "highest-risk-first",
      });

      const request = Decimal.fromString("10");

      expect(
        forward.computeDeleveragePlan(request).map((o) => o.asset)
      ).toEqual(["AAA"]);
      expect(
        reversed.computeDeleveragePlan(request).map((o) => o.asset)
      ).toEqual(["AAA"]);
    });

    it("spreads a pro-rata repayment in proportion to value", () => {
      const basket = new MultiCollateralBasket({
        positions: mixedBasket,
        deleveragePolicy: "pro-rata",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));

      expect(plan.map((order) => order.asset)).toEqual(["USDC", "XLM"]);
      expect(plan[0]!.amountToUnwind.toString()).toBe("25.0000000");
      expect(plan[1]!.amountToUnwind.toString()).toBe("125.0000000");
      expect(sumRepaid(plan).toString()).toBe("50.0000000");
    });

    it("keeps a pro-rata slice in proportion when there are more than two positions", () => {
      const basket = new MultiCollateralBasket({
        positions: [
          position("USDC", "100", "1.00", usdcModel),
          position("XLM", "500", "0.20", xlmModel),
          position("EURC", "100", "1.00", usdcModel),
        ],
        deleveragePolicy: "pro-rata",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("90"));

      // Each leg is worth $100 of a $300 basket, so each repays $30.
      expect(plan.map((order) => order.debtRepaidValue.toString())).toEqual([
        "30.0000000",
        "30.0000000",
        "30.0000000",
      ]);
    });

    it("draws the remainder a capped position left behind from the others", () => {
      // $100 and $1 of collateral against a $101 request. The first leg covers
      // its $100 cap, and the repayment still finishes at $101 rather than
      // stopping a rounding unit short.
      const basket = new MultiCollateralBasket({
        positions: [
          position("USDC", "100", "1.00", usdcModel),
          position("XLM", "5", "0.20", xlmModel),
        ],
        deleveragePolicy: "pro-rata",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("101"));

      expect(plan[0]!.debtRepaidValue.toString()).toBe("100.0000000");
      expect(plan[1]!.debtRepaidValue.toString()).toBe("1.0000000");
      expect(sumRepaid(plan).toString()).toBe("101.0000000");
    });

    it("absorbs rounding into the last slice instead of dropping it", () => {
      const basket = new MultiCollateralBasket({
        positions: [
          position("AAA", "3", "1.00", usdcModel),
          position("BBB", "3", "1.00", usdcModel),
          position("CCC", "3", "1.00", usdcModel),
        ],
        deleveragePolicy: "pro-rata",
      });

      const plan = basket.computeDeleveragePlan(Decimal.one());

      expect(sumRepaid(plan).toString()).toBe("1.0000000");
      expect(plan[2]!.debtRepaidValue.toString()).toBe("0.3333334");
    });

    it("reports a shortfall by repaying only what the basket holds", () => {
      const basket = new MultiCollateralBasket({
        positions: mixedBasket,
        deleveragePolicy: "highest-risk-first",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("150"));

      expect(sumRepaid(plan).toString()).toBe("150.0000000");

      const beyondCapacity = new MultiCollateralBasket({
        positions: [position("USDC", "100", "1.00", usdcModel)],
        deleveragePolicy: "highest-risk-first",
      });

      const capped = beyondCapacity.computeDeleveragePlan(
        Decimal.fromString("150")
      );

      expect(capped).toHaveLength(1);
      expect(capped[0]!.amountToUnwind.toString()).toBe("100.0000000");
      expect(sumRepaid(capped).toString()).toBe("100.0000000");
    });

    it("skips a position that holds nothing to sell", () => {
      const basket = new MultiCollateralBasket({
        positions: [
          position("USDC", "100", "1.00", usdcModel),
          position("DEAD", "500", "0", xlmModel),
        ],
        deleveragePolicy: "pro-rata",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));

      expect(plan.map((order) => order.asset)).toEqual(["USDC"]);
      expect(sumRepaid(plan).toString()).toBe("50.0000000");
    });

    it("drops a pro-rata slice that rounds to nothing", () => {
      // The dust leg is worth 0.0000001, so its share of a $1 repayment rounds
      // away at scale 7 and the plan carries one order rather than two.
      const basket = new MultiCollateralBasket({
        positions: [
          position("USDC", "10000000", "1.00", usdcModel),
          position("DUST", "1", "0.0000001", xlmModel),
        ],
        deleveragePolicy: "pro-rata",
      });

      const plan = basket.computeDeleveragePlan(Decimal.one());

      expect(plan.map((order) => order.asset)).toEqual(["USDC"]);
      expect(sumRepaid(plan).toString()).toBe("1.0000000");
    });

    it("returns no orders when the only position rounds to no value", () => {
      const basket = new MultiCollateralBasket({
        positions: [position("DUST", "0.0000001", "0.0000001", usdcModel)],
        deleveragePolicy: "pro-rata",
      });

      expect(basket.computeDeleveragePlan(Decimal.one())).toEqual([]);
    });

    it("passes over a position whose value rounds to nothing", () => {
      // Both amounts and prices are non-zero, so the position survives the
      // sellable filter, but its value rounds to zero at scale 7.
      const basket = new MultiCollateralBasket({
        positions: [
          position("DUST", "0.0000001", "0.0000001", usdcModel),
          position("USDC", "100", "1.00", usdcModel),
        ],
        deleveragePolicy: "highest-risk-first",
      });

      const plan = basket.computeDeleveragePlan(Decimal.fromString("50"));

      expect(plan.map((order) => order.asset)).toEqual(["USDC"]);
      expect(sumRepaid(plan).toString()).toBe("50.0000000");
    });

    it("is deterministic across repeated calls", () => {
      const basket = new MultiCollateralBasket({
        positions: mixedBasket,
        deleveragePolicy: "pro-rata",
      });

      const request = Decimal.fromString("150");

      expect(basket.computeDeleveragePlan(request)).toEqual(
        basket.computeDeleveragePlan(request)
      );
    });
  });
});
