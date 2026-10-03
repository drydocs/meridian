import { describe, expect, it } from "vitest";
import {
  accruePortfolioTick,
  createPortfolioState,
  FixedPointDecimal,
  preservesAccountingIdentity,
  YEAR_MILLISECONDS,
} from "./index";

const decimal = (value: string) => FixedPointDecimal.fromString(value);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe("portfolio accrual", () => {
  it("accrues annualized borrow interest and funding through accounting transactions", () => {
    const initial = createPortfolioState(decimal("1000"), decimal("100"));
    const result = accruePortfolioTick(initial, {
      elapsedMilliseconds: Number(YEAR_MILLISECONDS),
      borrowPositions: [
        {
          id: "loan",
          outstandingDebt: decimal("100"),
          annualRate: decimal("0.1"),
        },
      ],
      fundingPositions: [
        {
          id: "perp-long",
          notional: decimal("50"),
          annualRate: decimal("0.2"),
          side: "long",
        },
        {
          id: "hedge-short",
          notional: decimal("50"),
          annualRate: decimal("0.2"),
          side: "short",
        },
      ],
    });

    expect(
      result.transactions.map(({ type, amount }) => [type, amount.toString()])
    ).toEqual([
      ["borrow-interest", "10"],
      ["funding-payment", "10"],
      ["funding-payment", "-10"],
    ]);
    expect(result.portfolio.debt.toString()).toBe("110");
    expect(result.portfolio.cash.toString()).toBe("1000");
    expect(result.portfolio.equity.toString()).toBe("890");
    expect(preservesAccountingIdentity(result.portfolio)).toBe(true);
  });

  it("reconciles hourly and daily steps over the same interval", () => {
    const initial = createPortfolioState(decimal("1000"), decimal("100"));
    const borrowPositions = [
      {
        id: "loan",
        outstandingDebt: decimal("100"),
        annualRate: decimal("0.1"),
      },
    ];
    const fundingPositions = [
      {
        id: "hedge",
        notional: decimal("100"),
        annualRate: decimal("0.2"),
        side: "long" as const,
      },
    ];

    function runTicks(stepMilliseconds: number, tickCount: number) {
      let portfolio = initial;
      for (let tick = 0; tick < tickCount; tick += 1) {
        portfolio = accruePortfolioTick(portfolio, {
          elapsedMilliseconds: stepMilliseconds,
          borrowPositions,
          fundingPositions,
        }).portfolio;
      }
      return portfolio;
    }

    const hourly = runTicks(HOUR, 24 * 365);
    const daily = runTicks(DAY, 365);
    expect(hourly.debt.toStroops()).toBe(daily.debt.toStroops());
    expect(hourly.cash.toStroops()).toBe(daily.cash.toStroops());
    expect(hourly.equity.toStroops()).toBe(daily.equity.toStroops());
    expect(preservesAccountingIdentity(hourly)).toBe(true);
    expect(preservesAccountingIdentity(daily)).toBe(true);
  });

  it("rejects negative elapsed time and negative position balances", () => {
    const portfolio = createPortfolioState(decimal("100"));
    expect(() =>
      accruePortfolioTick(portfolio, {
        elapsedMilliseconds: -1,
        borrowPositions: [],
        fundingPositions: [],
      })
    ).toThrow(RangeError);
    expect(() =>
      accruePortfolioTick(portfolio, {
        elapsedMilliseconds: HOUR,
        borrowPositions: [
          {
            id: "loan",
            outstandingDebt: decimal("-1"),
            annualRate: decimal("0.1"),
          },
        ],
        fundingPositions: [],
      })
    ).toThrow(RangeError);
  });
});
