import { describe, expect, it } from "vitest";
import {
  accruePortfolioTick,
  createPortfolioState,
  FixedPointDecimal,
  preservesAccountingIdentity,
} from "./index";
import type { PortfolioState } from "./index";

const decimal = (value: string) => FixedPointDecimal.fromString(value);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const YEAR = 365 * DAY;
/** One stroop per unit per second, the coarsest non-zero rate a `FundingRate` can carry. */
const FUNDING_RATE = decimal("0.0000001");

const loan = (annualRate: string) => ({
  id: "loan",
  outstandingDebt: decimal("100"),
  annualRate: decimal(annualRate),
});

const fundingLeg = (ratePerSecond: string) => ({
  id: "hedge",
  notional: decimal("50"),
  rate: { ratePerSecond: decimal(ratePerSecond) },
});

describe("portfolio accrual", () => {
  it("accrues annualized borrow interest and funding through accounting transactions", () => {
    const initial = createPortfolioState(decimal("1000"), decimal("100"));
    const result = accruePortfolioTick(initial, {
      elapsedMilliseconds: YEAR,
      borrowPositions: [loan("0.1")],
      fundingPositions: [
        {
          id: "perp-receives",
          notional: decimal("50"),
          rate: { ratePerSecond: FUNDING_RATE },
        },
        {
          id: "perp-pays",
          notional: decimal("50"),
          rate: { ratePerSecond: decimal("-0.0000001") },
        },
      ],
    });

    expect(
      result.transactions.map(({ type, amount }) => [type, amount.toString()])
    ).toEqual([
      ["borrow-interest", "10"],
      ["funding-payment", "157.68"],
      ["funding-payment", "-157.68"],
    ]);
    expect(result.portfolio.debt.toString()).toBe("110");
    expect(result.portfolio.cash.toString()).toBe("1000");
    expect(result.portfolio.equity.toString()).toBe("890");
    expect(preservesAccountingIdentity(result.portfolio)).toBe(true);
  });

  it("credits cash on a receiving funding leg and debits it on a paying leg", () => {
    const initial = createPortfolioState(decimal("1000"), decimal("100"));

    const received = accruePortfolioTick(initial, {
      elapsedMilliseconds: YEAR,
      borrowPositions: [],
      fundingPositions: [fundingLeg("0.0000001")],
    });
    expect(received.portfolio.cash.toString()).toBe("1157.68");
    expect(received.portfolio.equity.toString()).toBe("1057.68");
    expect(preservesAccountingIdentity(received.portfolio)).toBe(true);

    const paid = accruePortfolioTick(initial, {
      elapsedMilliseconds: YEAR,
      borrowPositions: [],
      fundingPositions: [fundingLeg("-0.0000001")],
    });
    expect(paid.portfolio.cash.toString()).toBe("842.32");
    expect(paid.portfolio.equity.toString()).toBe("742.32");
    expect(preservesAccountingIdentity(paid.portfolio)).toBe(true);
  });

  it("accrues the same total under hourly and daily steps for a fixed balance", () => {
    const initial = createPortfolioState(decimal("1000"), decimal("100"));
    const borrowPositions = [loan("0.1")];
    const fundingPositions = [
      {
        id: "hedge",
        notional: decimal("100"),
        rate: { ratePerSecond: FUNDING_RATE },
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
    expect(hourly.debt.toString()).toBe("110");
    expect(preservesAccountingIdentity(hourly)).toBe(true);
    expect(preservesAccountingIdentity(daily)).toBe(true);
  });

  it("compounds when the caller re-supplies the accrued balance", () => {
    let portfolio = createPortfolioState(decimal("1000"), decimal("100"));
    let balance = decimal("100");

    for (let day = 0; day < 365; day += 1) {
      portfolio = accruePortfolioTick(portfolio, {
        elapsedMilliseconds: DAY,
        borrowPositions: [
          { id: "loan", outstandingDebt: balance, annualRate: decimal("0.1") },
        ],
        fundingPositions: [],
      }).portfolio;
      balance = portfolio.debt;
    }

    // Compounding beats the 110 a fixed balance accrues over the same year.
    expect(portfolio.debt.compareTo(decimal("110.5"))).toBeGreaterThan(0);
    expect(portfolio.debt.compareTo(decimal("110.6"))).toBeLessThan(0);
    expect(preservesAccountingIdentity(portfolio)).toBe(true);
  });

  it("rejects negative elapsed time, negative balances and negative borrow rates", () => {
    const portfolio = createPortfolioState(decimal("100"));
    const tick = (
      overrides: Partial<Parameters<typeof accruePortfolioTick>[1]>
    ) =>
      accruePortfolioTick(portfolio, {
        elapsedMilliseconds: HOUR,
        borrowPositions: [],
        fundingPositions: [],
        ...overrides,
      });

    expect(() => tick({ elapsedMilliseconds: -1 })).toThrow(RangeError);
    expect(() =>
      tick({
        borrowPositions: [{ ...loan("0.1"), outstandingDebt: decimal("-1") }],
      })
    ).toThrow(RangeError);
    expect(() => tick({ borrowPositions: [loan("-0.1")] })).toThrow(RangeError);
    expect(() =>
      tick({
        fundingPositions: [
          {
            id: "hedge",
            notional: decimal("-1"),
            rate: { ratePerSecond: FUNDING_RATE },
          },
        ],
      })
    ).toThrow(RangeError);
  });

  it("rejects repeated position ids so remainders cannot be shared", () => {
    const portfolio = createPortfolioState(decimal("100"));

    expect(() =>
      accruePortfolioTick(portfolio, {
        elapsedMilliseconds: HOUR,
        borrowPositions: [loan("0.1"), loan("0.2")],
        fundingPositions: [],
      })
    ).toThrow(RangeError);
  });

  it("drops carried remainders for positions that are no longer held", () => {
    const fresh = createPortfolioState(decimal("1000"), decimal("100"));
    const subStroopTick = {
      elapsedMilliseconds: 1,
      borrowPositions: [loan("0.1")],
      fundingPositions: [],
    };

    const first = accruePortfolioTick(fresh, subStroopTick);
    expect(first.transactions).toEqual([]);
    expect(
      first.portfolio.accrualRemainders["borrow:loan"] ?? 0n
    ).toBeGreaterThan(0n);

    const closed = accruePortfolioTick(first.portfolio, {
      elapsedMilliseconds: 1,
      borrowPositions: [],
      fundingPositions: [],
    });
    expect(closed.portfolio.accrualRemainders).toEqual({});

    const reopened = accruePortfolioTick(closed.portfolio, {
      elapsedMilliseconds: 1,
      borrowPositions: [loan("0.05")],
      fundingPositions: [],
    });
    const directly = accruePortfolioTick(fresh, {
      elapsedMilliseconds: 1,
      borrowPositions: [loan("0.05")],
      fundingPositions: [],
    });
    expect(reopened.portfolio.accrualRemainders).toEqual(
      directly.portfolio.accrualRemainders
    );
  });

  it("flags a portfolio whose equity disagrees with its cash and debt", () => {
    const inconsistent: PortfolioState = {
      cash: decimal("100"),
      debt: decimal("10"),
      equity: decimal("95"),
      accrualRemainders: {},
    };

    expect(preservesAccountingIdentity(inconsistent)).toBe(false);
  });
});
