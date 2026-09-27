import { Decimal } from "./decimal";
import {
  type SelfRepayingLoanConfig,
  parseSelfRepayingLoanConfig,
  type RawSelfRepayingLoanConfig,
} from "./config";
import { LiquidationParameterModel } from "./liquidation";

export type StrategyOrderType =
  | "supply_collateral"
  | "borrow"
  | "deploy_yield"
  | "harvest_yield"
  | "repay_debt"
  | "withdraw_yield"
  | "withdraw_collateral";

export interface StrategyOrder {
  readonly type: StrategyOrderType;
  readonly asset: string;
  readonly amount: Decimal;
  readonly target?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SelfRepayingLoanState {
  readonly collateralAsset: string;
  readonly collateralAmount: Decimal;
  readonly collateralPrice: Decimal;
  readonly borrowAsset: string;
  readonly borrowAssetPrice: Decimal;
  readonly debtAmount: Decimal;
  readonly yieldSource: string;
  readonly yieldDeployedPrincipal: Decimal;
  readonly totalYieldAmortized: Decimal;
  readonly totalInterestAccrued: Decimal;
  readonly isOpen: boolean;
  readonly isClosed: boolean;
}

export interface OpenLoanParams {
  readonly collateralAmount: Decimal;
  readonly collateralPrice: Decimal;
  readonly borrowAssetPrice?: Decimal | undefined;
}

export interface AmortizeStepParams {
  readonly state: SelfRepayingLoanState;
  readonly yieldAccrued: Decimal;
  readonly borrowInterestRatePeriod?: Decimal | undefined;
  readonly collateralPrice?: Decimal | undefined;
}

export interface CloseLoanParams {
  readonly state: SelfRepayingLoanState;
  readonly collateralPrice?: Decimal | undefined;
}

export interface StrategyStepResult {
  readonly nextState: SelfRepayingLoanState;
  readonly orders: StrategyOrder[];
}

/**
 * Flagship Self-Repaying Loan Strategy Core (Issue 886).
 *
 * Implements the full lifecycle:
 * 1. `open`: supply collateral, borrow up to configured target LTV, deploy borrowed capital to yield source.
 * 2. `amortize`: on periodic ticks, harvest accrued yield and route proceeds directly into debt repayment.
 * 3. `close`: unwind yield position, clear residual debt, and withdraw initial collateral.
 *
 * Emits declarative orders to the execution runner without in-place state mutation.
 */
export class SelfRepayingLoanStrategy {
  readonly config: SelfRepayingLoanConfig;
  readonly liquidationModel: LiquidationParameterModel;

  constructor(config: SelfRepayingLoanConfig | RawSelfRepayingLoanConfig) {
    this.config =
      "collateralAsset" in config && typeof config.collateralAsset === "string"
        ? parseSelfRepayingLoanConfig(config as RawSelfRepayingLoanConfig)
        : (config as SelfRepayingLoanConfig);

    this.liquidationModel = new LiquidationParameterModel({
      maxLoanToValue: this.config.openingLoanToValue,
      liquidationThreshold: this.config.liquidationThreshold,
      liquidationPenalty: this.config.liquidationPenalty,
    });
  }

  /**
   * Opens a new self-repaying loan position.
   * Calculates maximum borrow amount respecting opening loan-to-value (LTV) target,
   * generates supply, borrow, and deploy orders.
   */
  open(params: OpenLoanParams): StrategyStepResult {
    if (params.collateralAmount.lte(Decimal.zero())) {
      throw new RangeError("Collateral amount must be strictly positive to open a loan");
    }
    if (params.collateralPrice.lte(Decimal.zero())) {
      throw new RangeError("Collateral price must be strictly positive");
    }

    const borrowPrice = params.borrowAssetPrice ?? Decimal.one();
    if (borrowPrice.lte(Decimal.zero())) {
      throw new RangeError("Borrow asset price must be strictly positive");
    }

    const collateralValue = params.collateralAmount.mul(params.collateralPrice);
    const maxBorrowValue = collateralValue.mul(this.config.openingLoanToValue);
    const borrowAmount = maxBorrowValue.div(borrowPrice);

    if (borrowAmount.isZero()) {
      throw new RangeError("Borrow amount calculated to zero from given collateral");
    }

    const orders: StrategyOrder[] = [
      {
        type: "supply_collateral",
        asset: this.config.collateralAsset,
        amount: params.collateralAmount,
      },
      {
        type: "borrow",
        asset: this.config.borrowAsset,
        amount: borrowAmount,
      },
      {
        type: "deploy_yield",
        asset: this.config.borrowAsset,
        amount: borrowAmount,
        target: this.config.yieldSource,
      },
    ];

    const nextState: SelfRepayingLoanState = {
      collateralAsset: this.config.collateralAsset,
      collateralAmount: params.collateralAmount,
      collateralPrice: params.collateralPrice,
      borrowAsset: this.config.borrowAsset,
      borrowAssetPrice: borrowPrice,
      debtAmount: borrowAmount,
      yieldSource: this.config.yieldSource,
      yieldDeployedPrincipal: borrowAmount,
      totalYieldAmortized: Decimal.zero(),
      totalInterestAccrued: Decimal.zero(),
      isOpen: true,
      isClosed: false,
    };

    return { nextState, orders };
  }

  /**
   * Executes a periodic amortization step:
   * 1. Applies period borrow interest to outstanding debt.
   * 2. Routes accrued yield from yield source to repay debt.
   * 3. Emits harvest_yield and repay_debt orders.
   */
  amortize(params: AmortizeStepParams): StrategyStepResult {
    if (!params.state.isOpen || params.state.isClosed) {
      throw new Error("Cannot amortize a closed or uninitialized loan");
    }

    const orders: StrategyOrder[] = [];
    const currentPrice = params.collateralPrice ?? params.state.collateralPrice;
    const interestRate = params.borrowInterestRatePeriod ?? Decimal.zero();

    // 1. Accrue borrow interest on current debt
    const interestAccrued = params.state.debtAmount.mul(interestRate);
    const debtWithInterest = params.state.debtAmount.add(interestAccrued);

    let repayAmount = Decimal.zero();
    let remainingDebt = debtWithInterest;

    if (params.yieldAccrued.gt(Decimal.zero()) && debtWithInterest.gt(Decimal.zero())) {
      if (params.yieldAccrued.gte(debtWithInterest)) {
        repayAmount = debtWithInterest;
        remainingDebt = Decimal.zero();
      } else {
        repayAmount = params.yieldAccrued;
        remainingDebt = debtWithInterest.sub(params.yieldAccrued);
      }

      orders.push(
        {
          type: "harvest_yield",
          asset: this.config.borrowAsset,
          amount: repayAmount,
          target: this.config.yieldSource,
        },
        {
          type: "repay_debt",
          asset: this.config.borrowAsset,
          amount: repayAmount,
        }
      );
    }

    const nextState: SelfRepayingLoanState = {
      ...params.state,
      collateralPrice: currentPrice,
      debtAmount: remainingDebt,
      totalYieldAmortized: params.state.totalYieldAmortized.add(repayAmount),
      totalInterestAccrued: params.state.totalInterestAccrued.add(interestAccrued),
    };

    return { nextState, orders };
  }

  /**
   * Closes the loan position:
   * 1. Unwinds deployed yield position (`withdraw_yield`).
   * 2. Repays any residual debt balance (`repay_debt`).
   * 3. Withdraws supplied collateral (`withdraw_collateral`).
   */
  close(params: CloseLoanParams): StrategyStepResult {
    if (!params.state.isOpen || params.state.isClosed) {
      throw new Error("Cannot close an uninitialized or already closed loan");
    }

    const orders: StrategyOrder[] = [];

    // 1. Withdraw deployed yield principal
    if (params.state.yieldDeployedPrincipal.gt(Decimal.zero())) {
      orders.push({
        type: "withdraw_yield",
        asset: this.config.borrowAsset,
        amount: params.state.yieldDeployedPrincipal,
        target: this.config.yieldSource,
      });
    }

    // 2. Repay residual debt if any
    if (params.state.debtAmount.gt(Decimal.zero())) {
      orders.push({
        type: "repay_debt",
        asset: this.config.borrowAsset,
        amount: params.state.debtAmount,
      });
    }

    // 3. Withdraw original collateral
    if (params.state.collateralAmount.gt(Decimal.zero())) {
      orders.push({
        type: "withdraw_collateral",
        asset: this.config.collateralAsset,
        amount: params.state.collateralAmount,
      });
    }

    const nextState: SelfRepayingLoanState = {
      ...params.state,
      collateralAmount: Decimal.zero(),
      debtAmount: Decimal.zero(),
      yieldDeployedPrincipal: Decimal.zero(),
      isOpen: false,
      isClosed: true,
    };

    return { nextState, orders };
  }

  /**
   * Computes current Loan-to-Value (LTV) for a given loan state:
   * LTV = (Debt * BorrowPrice) / (Collateral * CollateralPrice)
   */
  computeCurrentLtv(state: SelfRepayingLoanState): Decimal {
    const collateralVal = state.collateralAmount.mul(state.collateralPrice);
    if (collateralVal.isZero()) {
      return state.debtAmount.isZero() ? Decimal.zero() : Decimal.one();
    }
    const debtVal = state.debtAmount.mul(state.borrowAssetPrice);
    return debtVal.div(collateralVal);
  }

  /**
   * Computes current Health Factor for a given loan state:
   * HF = (Collateral * CollateralPrice * LiquidationThreshold) / (Debt * BorrowPrice)
   */
  computeHealthFactor(state: SelfRepayingLoanState): Decimal | undefined {
    if (state.debtAmount.isZero()) {
      return undefined;
    }
    const collateralVal = state.collateralAmount.mul(state.collateralPrice);
    const debtVal = state.debtAmount.mul(state.borrowAssetPrice);
    return this.liquidationModel.computeHealthFactor(collateralVal, debtVal);
  }
}
