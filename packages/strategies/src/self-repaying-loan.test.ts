import { describe, expect, it } from "vitest";

import { Decimal } from "./decimal";
import {
  ConfigValidationError,
  parseSelfRepayingLoanConfig,
  type RawSelfRepayingLoanConfig,
} from "./config";
import {
  SelfRepayingLoanStrategy,
  type SelfRepayingLoanState,
} from "./self-repaying-loan";

describe("SelfRepayingLoanStrategy", () => {
  const baseConfig: RawSelfRepayingLoanConfig = {
    collateralAsset: "XLM",
    borrowAsset: "USDC",
    yieldSource: "blend-pool",
    openingLoanToValue: Decimal.fromString("0.50"), // 50% LTV
    deleverageBuffer: Decimal.fromString("0.05"),
    deleverageTargetLtv: Decimal.fromString("0.55"),
    liquidationThreshold: Decimal.fromString("0.75"), // 75%
    liquidationPenalty: Decimal.fromString("0.08"),
    borrowRate: {
      mode: "fixed",
      fixedRate: Decimal.fromString("0.05"), // 5%
    },
  };

  const strategy = new SelfRepayingLoanStrategy(baseConfig);

  describe("constructor", () => {
    it("accepts a raw config and parses it", () => {
      const parsed = new SelfRepayingLoanStrategy(baseConfig);
      expect(parsed.config.collateralAsset).toBe("XLM");
      expect(parsed.config.borrowRate.mode).toBe("fixed");
    });

    it("normalizes and re-validates an already-parsed config", () => {
      const parsed = parseSelfRepayingLoanConfig(baseConfig);
      const strategyFromParsed = new SelfRepayingLoanStrategy(parsed);
      // The constructor always re-parses, producing an equal-but-distinct
      // normalized copy rather than keeping the caller's reference.
      expect(strategyFromParsed.config).not.toBe(parsed);
      expect(strategyFromParsed.config).toEqual(parsed);

      // Validation therefore still applies to parsed-looking configs.
      expect(
        () =>
          new SelfRepayingLoanStrategy({
            ...parsed,
            openingLoanToValue: Decimal.one(),
          })
      ).toThrowError(ConfigValidationError);
    });

    it("builds the liquidation model from the config risk parameters", () => {
      expect(strategy.liquidationModel.liquidationThreshold.toString()).toBe(
        "0.7500000"
      );
      expect(strategy.liquidationModel.maxLoanToValue.toString()).toBe(
        "0.5000000"
      );
      expect(strategy.liquidationModel.liquidationPenalty.toString()).toBe(
        "0.0800000"
      );
    });
  });

  describe("open", () => {
    it("opens a loan with hand-worked figures and emits supply/borrow/deploy orders", () => {
      // 10,000 XLM collateral at $0.20/XLM = $2,000 collateral value
      // 50% opening LTV = $1,000 USDC borrowed
      const collateralAmount = Decimal.fromString("10000");
      const collateralPrice = Decimal.fromString("0.20");

      const result = strategy.open({ collateralAmount, collateralPrice });

      expect(result.orders).toHaveLength(3);
      expect(result.orders[0]).toEqual({
        type: "supply_collateral",
        asset: "XLM",
        amount: collateralAmount,
      });
      expect(result.orders[1]).toEqual({
        type: "borrow",
        asset: "USDC",
        amount: Decimal.fromString("1000"),
      });
      expect(result.orders[2]).toEqual({
        type: "deploy_yield",
        asset: "USDC",
        amount: Decimal.fromString("1000"),
        target: "blend-pool",
      });

      expect(result.nextState.isOpen).toBe(true);
      expect(result.nextState.isClosed).toBe(false);
      expect(result.nextState.debtAmount.toString()).toBe("1000.0000000");
      expect(result.nextState.yieldDeployedPrincipal.toString()).toBe(
        "1000.0000000"
      );
      expect(result.nextState.totalYieldAmortized.isZero()).toBe(true);
      expect(result.nextState.totalInterestAccrued.isZero()).toBe(true);

      // LTV matches the opening LTV target exactly: 1,000 / 2,000 = 0.50
      expect(strategy.computeCurrentLtv(result.nextState).toString()).toBe(
        "0.5000000"
      );

      // Health factor: (2,000 * 0.75) / 1,000 = 1.50
      expect(strategy.computeHealthFactor(result.nextState)?.toString()).toBe(
        "1.5000000"
      );
    });

    it("converts the borrow value at the borrow asset price", () => {
      // 100 XLM at $2.00 = $200 value; 50% LTV = $100 of borrow value
      // USDC priced at $0.50 -> borrow 200 USDC
      const result = strategy.open({
        collateralAmount: Decimal.fromString("100"),
        collateralPrice: Decimal.fromString("2.00"),
        borrowAssetPrice: Decimal.fromString("0.50"),
      });

      expect(result.orders[1]?.amount.toString()).toBe("200.0000000");
      expect(result.nextState.debtAmount.toString()).toBe("200.0000000");
      expect(result.nextState.borrowAssetPrice.toString()).toBe("0.5000000");
      // LTV in value terms is unchanged: 200 * 0.50 / 200 = 0.50
      expect(strategy.computeCurrentLtv(result.nextState).toString()).toBe(
        "0.5000000"
      );
    });

    it("defaults the borrow asset price to 1", () => {
      const result = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      });
      expect(result.nextState.borrowAssetPrice.toString()).toBe("1.0000000");
    });

    it("rejects zero or negative collateral amount", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.zero(),
          collateralPrice: Decimal.fromString("0.20"),
        })
      ).toThrowError(RangeError);
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.fromString("-1"),
          collateralPrice: Decimal.fromString("0.20"),
        })
      ).toThrowError(RangeError);
    });

    it("rejects zero or negative collateral price", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.fromString("10000"),
          collateralPrice: Decimal.zero(),
        })
      ).toThrowError(RangeError);
    });

    it("rejects zero or negative borrow asset price", () => {
      expect(() =>
        strategy.open({
          collateralAmount: Decimal.fromString("10000"),
          collateralPrice: Decimal.fromString("0.20"),
          borrowAssetPrice: Decimal.fromString("-0.10"),
        })
      ).toThrowError(RangeError);
    });

    it("rejects when the borrow amount rounds down to zero", () => {
      // Opening LTV of 0.0000001 on 1 stroop of collateral rounds to zero borrow
      const tinyLtvConfig: RawSelfRepayingLoanConfig = {
        ...baseConfig,
        openingLoanToValue: Decimal.fromString("0.0000001"),
      };
      const tinyLtvStrategy = new SelfRepayingLoanStrategy(tinyLtvConfig);
      expect(() =>
        tinyLtvStrategy.open({
          collateralAmount: Decimal.fromString("0.0000001"),
          collateralPrice: Decimal.one(),
        })
      ).toThrowError(RangeError);
    });
  });

  describe("amortize", () => {
    function openLoan(): SelfRepayingLoanState {
      return strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;
    }

    it("routes yield into debt repayment until the loan is fully repaid", () => {
      // Debt = $1,000; 0% period interest for clean accounting
      const state = openLoan();

      // Step 1: $300 yield -> debt 700
      const step1 = strategy.amortize({
        state,
        yieldAccrued: Decimal.fromString("300"),
      });
      expect(step1.nextState.debtAmount.toString()).toBe("700.0000000");
      expect(step1.nextState.totalYieldAmortized.toString()).toBe(
        "300.0000000"
      );
      expect(step1.orders).toHaveLength(2);
      expect(step1.orders[0]?.type).toBe("harvest_yield");
      expect(step1.orders[0]?.amount.toString()).toBe("300.0000000");
      expect(step1.orders[0]?.target).toBe("blend-pool");
      expect(step1.orders[1]?.type).toBe("repay_debt");
      expect(step1.orders[1]?.amount.toString()).toBe("300.0000000");

      // Step 2: another $300 yield -> debt 400
      const step2 = strategy.amortize({
        state: step1.nextState,
        yieldAccrued: Decimal.fromString("300"),
      });
      expect(step2.nextState.debtAmount.toString()).toBe("400.0000000");
      expect(step2.nextState.totalYieldAmortized.toString()).toBe(
        "600.0000000"
      );

      // Step 3: $500 yield exceeds the remaining $400 debt ->
      // repays exactly $400 and leaves the debt at zero
      const step3 = strategy.amortize({
        state: step2.nextState,
        yieldAccrued: Decimal.fromString("500"),
      });
      expect(step3.nextState.debtAmount.isZero()).toBe(true);
      expect(step3.nextState.totalYieldAmortized.toString()).toBe(
        "1000.0000000"
      );
      expect(step3.orders[0]?.amount.toString()).toBe("400.0000000");
      expect(step3.orders[1]?.amount.toString()).toBe("400.0000000");
    });

    it("accrues borrow interest on the outstanding debt before repaying", () => {
      // Debt = 1,000; 1% period interest -> +10 -> 1,010; yield 100 -> debt 910
      const step = strategy.amortize({
        state: openLoan(),
        yieldAccrued: Decimal.fromString("100"),
        borrowInterestRatePeriod: Decimal.fromString("0.01"),
      });

      expect(step.nextState.debtAmount.toString()).toBe("910.0000000");
      expect(step.nextState.totalInterestAccrued.toString()).toBe("10.0000000");
      expect(step.nextState.totalYieldAmortized.toString()).toBe("100.0000000");
    });

    it("still accrues interest when there is no yield to harvest", () => {
      // Debt = 1,000; 2% period interest -> debt 1,020; no harvest/repay orders
      const step = strategy.amortize({
        state: openLoan(),
        yieldAccrued: Decimal.zero(),
        borrowInterestRatePeriod: Decimal.fromString("0.02"),
      });

      expect(step.orders).toHaveLength(0);
      expect(step.nextState.debtAmount.toString()).toBe("1020.0000000");
      expect(step.nextState.totalInterestAccrued.toString()).toBe("20.0000000");
      expect(step.nextState.totalYieldAmortized.isZero()).toBe(true);
    });

    it("updates the tracked collateral price when one is supplied", () => {
      const step = strategy.amortize({
        state: openLoan(),
        yieldAccrued: Decimal.zero(),
        collateralPrice: Decimal.fromString("0.25"),
      });
      expect(step.nextState.collateralPrice.toString()).toBe("0.2500000");
    });

    it("keeps the existing collateral price when none is supplied", () => {
      const step = strategy.amortize({
        state: openLoan(),
        yieldAccrued: Decimal.zero(),
      });
      expect(step.nextState.collateralPrice.toString()).toBe("0.2000000");
    });

    it("does not mutate the input state", () => {
      const state = openLoan();
      strategy.amortize({
        state,
        yieldAccrued: Decimal.fromString("100"),
      });
      expect(state.debtAmount.toString()).toBe("1000.0000000");
      expect(state.totalYieldAmortized.isZero()).toBe(true);
    });

    it("rejects amortizing a closed loan", () => {
      const closed = strategy.close({ state: openLoan() }).nextState;
      expect(() =>
        strategy.amortize({ state: closed, yieldAccrued: Decimal.one() })
      ).toThrowError("Cannot amortize a closed or uninitialized loan");
    });

    it("rejects amortizing an uninitialized loan", () => {
      const uninitialized: SelfRepayingLoanState = {
        ...openLoan(),
        isOpen: false,
        isClosed: false,
      };
      expect(() =>
        strategy.amortize({ state: uninitialized, yieldAccrued: Decimal.one() })
      ).toThrowError("Cannot amortize a closed or uninitialized loan");
    });
  });

  describe("close", () => {
    function openLoan(): SelfRepayingLoanState {
      return strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;
    }

    it("unwinds yield, repays residual debt, and withdraws collateral", () => {
      // Partial amortization leaves $600 of residual debt
      const amortized = strategy.amortize({
        state: openLoan(),
        yieldAccrued: Decimal.fromString("400"),
      }).nextState;

      const result = strategy.close({ state: amortized });

      expect(result.orders).toHaveLength(3);
      expect(result.orders[0]).toEqual({
        type: "withdraw_yield",
        asset: "USDC",
        amount: Decimal.fromString("1000"),
        target: "blend-pool",
      });
      expect(result.orders[1]).toEqual({
        type: "repay_debt",
        asset: "USDC",
        amount: Decimal.fromString("600"),
      });
      expect(result.orders[2]).toEqual({
        type: "withdraw_collateral",
        asset: "XLM",
        amount: Decimal.fromString("10000"),
      });

      expect(result.nextState.isOpen).toBe(false);
      expect(result.nextState.isClosed).toBe(true);
      expect(result.nextState.debtAmount.isZero()).toBe(true);
      expect(result.nextState.collateralAmount.isZero()).toBe(true);
      expect(result.nextState.yieldDeployedPrincipal.isZero()).toBe(true);
    });

    it("omits the repay order when the debt is already fully repaid", () => {
      const fullyAmortized = strategy.amortize({
        state: openLoan(),
        yieldAccrued: Decimal.fromString("1000"),
      }).nextState;
      expect(fullyAmortized.debtAmount.isZero()).toBe(true);

      const result = strategy.close({ state: fullyAmortized });

      expect(result.orders).toHaveLength(2);
      expect(result.orders[0]?.type).toBe("withdraw_yield");
      expect(result.orders[1]?.type).toBe("withdraw_collateral");
    });

    it("rejects closing an already closed loan", () => {
      const closed = strategy.close({ state: openLoan() }).nextState;
      expect(() => strategy.close({ state: closed })).toThrowError(
        "Cannot close an uninitialized or already closed loan"
      );
    });

    it("rejects closing an uninitialized loan", () => {
      const uninitialized: SelfRepayingLoanState = {
        ...openLoan(),
        isOpen: false,
      };
      expect(() => strategy.close({ state: uninitialized })).toThrowError(
        "Cannot close an uninitialized or already closed loan"
      );
    });
  });

  describe("computeCurrentLtv", () => {
    it("computes LTV from debt value over collateral value", () => {
      // 10,000 XLM at 0.20 = 2,000; opening LTV borrows $1,000 of value
      // = 909.0909091 USDC at $1.10; LTV = 1,000/2,000 = 0.50 exactly.
      const state = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
        borrowAssetPrice: Decimal.fromString("1.10"),
      }).nextState;

      expect(state.debtAmount.toString()).toBe("909.0909091");
      expect(strategy.computeCurrentLtv(state).toString()).toBe("0.5000000");

      // Mark the borrow asset price up after opening: the same USDC debt is
      // now worth 909.0909091 * 1.50 = 1,363.6363637 of value.
      // LTV = 1,363.6363637 / 2,000 = 0.6818182.
      const repriced: SelfRepayingLoanState = {
        ...state,
        borrowAssetPrice: Decimal.fromString("1.50"),
      };
      expect(strategy.computeCurrentLtv(repriced).toString()).toBe("0.6818182");

      // A further price rise pushes LTV higher still: 909.0909091 * 2 =
      // 1,818.1818182 over 2,000 -> 0.9090909.
      const stressed: SelfRepayingLoanState = {
        ...state,
        borrowAssetPrice: Decimal.fromString("2.00"),
      };
      expect(strategy.computeCurrentLtv(stressed).toString()).toBe("0.9090909");
    });

    it("returns zero when collateral value and debt are both zero", () => {
      const state = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;
      const emptyState: SelfRepayingLoanState = {
        ...state,
        collateralAmount: Decimal.zero(),
        debtAmount: Decimal.zero(),
      };
      expect(strategy.computeCurrentLtv(emptyState).toString()).toBe(
        "0.0000000"
      );
    });

    it("returns one for debt against zero collateral value", () => {
      const state = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;
      const underwater: SelfRepayingLoanState = {
        ...state,
        collateralAmount: Decimal.zero(),
      };
      expect(strategy.computeCurrentLtv(underwater).toString()).toBe(
        "1.0000000"
      );
    });
  });

  describe("computeHealthFactor", () => {
    it("computes HF as collateral value times threshold over debt value", () => {
      // (10,000 * 0.20 * 0.75) / 1,000 = 1.50
      const state = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;

      expect(strategy.computeHealthFactor(state)?.toString()).toBe("1.5000000");
    });

    it("drops as the collateral price falls", () => {
      // Opened at $0.20 the loan borrows $1,000 against $2,000 of collateral
      const state = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;

      expect(strategy.computeHealthFactor(state)?.toString()).toBe("1.5000000");

      // A fall to $0.15 gives (10,000 * 0.15 * 0.75) / 1,000 = 1.125
      const stressed: SelfRepayingLoanState = {
        ...state,
        collateralPrice: Decimal.fromString("0.15"),
      };
      expect(strategy.computeHealthFactor(stressed)?.toString()).toBe(
        "1.1250000"
      );

      // A deeper fall to $0.10 gives (10,000 * 0.10 * 0.75) / 1,000 = 0.75
      const deeper: SelfRepayingLoanState = {
        ...state,
        collateralPrice: Decimal.fromString("0.10"),
      };
      expect(strategy.computeHealthFactor(deeper)?.toString()).toBe(
        "0.7500000"
      );
    });

    it("returns undefined for a debt-free position", () => {
      const state = strategy.open({
        collateralAmount: Decimal.fromString("10000"),
        collateralPrice: Decimal.fromString("0.20"),
      }).nextState;
      const debtFree: SelfRepayingLoanState = {
        ...state,
        debtAmount: Decimal.zero(),
      };
      expect(strategy.computeHealthFactor(debtFree)).toBeUndefined();
    });
  });
});
