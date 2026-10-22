# Self-repaying loan strategy

A self-repaying loan borrows against collateral, puts the borrowed funds to
work in a yield source, and uses the yield to pay the loan down. If the yield
outpaces the borrow interest for long enough, the debt reaches zero and the
borrower gets the full collateral back without repaying from their own
pocket.

**Simulation only.** This strategy runs against the backtest harness in
`@meridian/strategies`. It is not wired to any live vault, lending pool, or
mainnet funds. The strategy emits declarative orders (`supply_collateral`,
`borrow`, `deploy_yield`, and so on) but nothing in the repository executes
them on-chain. Every number on this page comes from a simulated scenario, not
from a live account.

## How it works

The strategy core is `SelfRepayingLoanStrategy` in
`packages/strategies/src/self-repaying-loan.ts`. A position goes through three
steps.

### 1. Open: collateral, borrow, deploy

`open()` takes a collateral amount and price (and optionally a borrow asset
price, which defaults to `1`). It then:

1. supplies the collateral,
2. borrows `collateralAmount × collateralPrice × openingLoanToValue ÷ borrowAssetPrice`
   of the borrow asset,
3. deploys the whole borrowed amount to the configured yield source.

These come out as three orders: `supply_collateral`, `borrow`, `deploy_yield`.
The returned state records the debt and the deployed principal, which start
equal.

For example, 1000 USDC of collateral at a price of `1` with an
`openingLoanToValue` of `0.5` borrows 500 of the borrow asset and deploys all 500.

### 2. Amortize: yield pays the debt

`amortize()` is called once per period with the yield the deployed funds
earned in that period and, optionally, the period borrow rate and a fresh
collateral price. Each call:

1. adds interest to the debt: `debt × borrowInterestRatePeriod`, or
   `debt × fixedRate` from the config when no period rate is passed (see
   [Rate modes](#rate-modes)),
2. uses the period's yield to repay as much of that debt as it can,
3. emits a `harvest_yield` and a `repay_debt` order for the repaid amount.

If the yield is larger than the remaining debt, only the debt is repaid. The
deployed principal is never touched by amortization: the debt is paid from
yield alone.

### 3. Close: unwind and withdraw

`close()` withdraws the deployed principal, repays whatever debt is left, and
withdraws the collateral (`withdraw_yield`, `repay_debt`,
`withdraw_collateral`). It refuses to close when the deployed principal plus
an optional `additionalRepayment` from the borrower is smaller than the
remaining debt, and reports the shortfall in the error.

### Health factor and LTV

Two numbers describe how close a position is to liquidation:

- **LTV** = `debt × borrowAssetPrice ÷ (collateral × collateralPrice)`
  (`computeCurrentLtv`).
- **Health factor (HF)** = `collateral × collateralPrice × liquidationThreshold ÷ (debt × borrowAssetPrice)`
  (`computeHealthFactor`).

A position is liquidatable when its health factor is strictly below `1.0`.
With no debt the health factor is undefined and the position can never be
liquidated.

## Configuration

`SelfRepayingLoanStrategy` takes a `RawSelfRepayingLoanConfig`, which
`parseSelfRepayingLoanConfig` in `packages/strategies/src/config.ts` validates
on construction. An invalid field throws a `ConfigValidationError` whose
`field` property names the offending option. All rates and ratios are
`Decimal` values (for example `Decimal.fromString("0.05")` for 5%), never
JavaScript numbers.

| Option                    | Meaning                                                                     | Accepted values                                                                            |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `collateralAsset`         | Asset supplied as collateral                                                | One of `USDC`, `XLM`, `USDG`, `EURC`, `BTC`, `ETH`                                         |
| `borrowAsset`             | Asset borrowed and deployed                                                 | Same list; must differ from `collateralAsset`                                              |
| `yieldSource`             | Where the borrowed funds are deployed (label on `deploy_yield` orders)      | One of `blend-pool`, `defindex-vault`, `stellar-anchor`, `meridian-vault`                  |
| `openingLoanToValue`      | Fraction of collateral value borrowed at open                               | `0` or more, below `1`, and strictly below `liquidationThreshold`                          |
| `liquidationThreshold`    | Fraction of collateral value counted toward health                          | `0` to `1`; must be greater than zero                                                      |
| `liquidationPenalty`      | Penalty on a liquidated position                                            | `0` or more                                                                                |
| `deleverageBuffer`        | Margin below `liquidationThreshold` where deleveraging should begin         | `0` or more, strictly below `liquidationThreshold`                                         |
| `deleverageTargetLtv`     | LTV to restore to after deleveraging                                        | At least `openingLoanToValue` and strictly below `liquidationThreshold - deleverageBuffer` |
| `borrowRate`              | Borrow rate model, `fixed` or `variable` (see below)                        | See below                                                                                  |
| `initialCollateralAmount` | Optional starting collateral                                                | Optional                                                                                   |
| `collateralSet`           | Optional list of `{ asset, amount, liquidationModel }` for multi-collateral | If given: not empty, every `asset` from the known list, every `amount` `0` or more         |

Put together, the LTV levels must sit in this order:

```text
openingLoanToValue <= deleverageTargetLtv < liquidationThreshold - deleverageBuffer <= liquidationThreshold <= 1
```

A conservative starting point is an `openingLoanToValue` well below the
threshold (the scenario tests use `0.5` against a threshold of `0.85`), which
leaves room for the collateral price to fall before deleveraging or
liquidation becomes relevant.

### Rate modes

`borrowRate.mode` selects one of two shapes:

- **`fixed`**: `{ mode: "fixed", fixedRate }`. `fixedRate` must be `0` or
  more. It is a rate per period, which `amortize()` charges when the call
  passes no `borrowInterestRatePeriod`.
- **`variable`**: `{ mode: "variable", baseRate, slope1, slope2, optimalUtilization }`,
  the usual kinked utilization curve: `baseRate` is the floor, `slope1` applies
  below `optimalUtilization`, `slope2` above it. `baseRate`, `slope1` and
  `slope2` must be `0` or more; `optimalUtilization` must be between `0` and
  `1`. `amortize()` has no utilization to evaluate the curve with, so a
  variable-rate loan must pass `borrowInterestRatePeriod` on every call;
  without it the call throws.

Any other `mode` is rejected. A `borrowInterestRatePeriod` passed to
`amortize()`, including `0`, always takes precedence over the configured rate.

### What the configuration does not do yet

Some options are validated but not yet read by the strategy or the backtest
runner. This guide documents the code as it is, so the gaps are stated
plainly:

- **The variable `borrowRate` curve is not evaluated.** Only a `fixed` rate
  is applied, by `amortize()`; a variable-rate caller supplies the period
  rate itself. The backtest runner does not read `borrowRate` at all: it
  charges the `borrowInterestRate` of each tick.
- **`deleverageBuffer` and `deleverageTargetLtv` do not drive deleveraging.**
  Auto-deleverage is configured in health-factor terms on the monitor and the
  backtest runner (next section), not from these LTV fields.
- **`initialCollateralAmount` and `collateralSet` are validated only.** The
  strategy takes its collateral from the `open()` call, and the
  self-repaying-loan path is single-collateral.
- **`liquidationPenalty` is carried, not charged.** It is stored on the
  liquidation model for consumers, but neither the strategy nor the backtest
  runner deducts it.

## Risks and how auto-deleverage helps

A self-repaying loan is still a loan. The collateral can be lost.

- **Yield collapse.** Repayment only happens while the yield source pays. If
  the yield drops to zero, repayment stops, borrow interest keeps adding to
  the debt, and the loan stops repaying itself. Nothing in the strategy
  replaces the missing yield; the borrower either waits, repays from their
  own funds via `additionalRepayment` on close, or keeps carrying a growing
  debt.
- **Interest above yield.** Interest is added before yield is applied each
  period. When the period borrow rate on the current debt is larger than the
  period yield, the debt grows even though yield is being earned.
- **Collateral drawdown.** The debt does not shrink when the collateral price
  falls, so the health factor drops with the price. A deep enough fall pushes
  it below `1.0`.
- **Liquidation.** Below a health factor of `1.0` the position is
  liquidatable. In the backtest a liquidation ends the run on that tick.
- **Yield source risk.** The deployed principal is assumed to be there in full
  at close. The simulation does not model a loss, freeze, or exploit of the
  yield source itself.

### Auto-deleverage

Auto-deleverage sells some collateral and uses the proceeds to repay debt
before the health factor reaches `1.0`. Selling collateral and repaying debt
by the same value raises the health factor, because the threshold discount
applies to the collateral but not to the debt.

It is implemented in `HealthFactorMonitor` (`packages/strategies/src/monitor.ts`)
and, with the same formula, inside the backtest runner:

- Deleveraging triggers when the health factor falls below a trigger level.
  On the monitor that is `1 + safetyBuffer`; on the runner it is
  `deleverageThresholdHf` (default `1.20`, must be greater than `1.0`).
- It repays enough debt to bring the health factor back to a target:
  `targetHealthFactor` on the monitor (must be greater than the trigger),
  `deleverageTargetHf` on the runner (default `1.40`, must be greater than
  the threshold).
- The repayment is `(targetHf × debt - collateralValue × threshold) ÷ (targetHf - threshold)`,
  capped at the debt and at the collateral's value, and the collateral sold
  is that repayment divided by the collateral price.

Deleveraging reduces risk but has limits:

- It is not free. Each deleverage permanently sells collateral at the
  current, already depressed, price.
- It cannot save a position whose collateral is worth too little. When the
  whole collateral is sold and debt is still left, the position is
  liquidated anyway (Scenario 4 below).
- It only runs when it is checked. In the backtest that is once per tick, so
  a price move that jumps straight through the trigger within one tick is
  seen only at the next check.
- The simulation sells collateral at exactly the tick price into the borrow
  asset at a price of `1`, with no slippage, fees, or liquidity limit.

## Running a scenario backtest

The backtest harness is `SelfRepayingLoanRunner` in
`packages/strategies/src/scenario-runner.ts`. There is no standalone backtest
CLI; scenarios are run through the package's Vitest suite.

### Run the bundled scenarios

From the repository root:

```bash
pnpm install
pnpm --filter @meridian/strategies test
```

`packages/strategies/src/scenario-runner.test.ts` runs four scenarios against
1000 USDC of collateral and 500 USDG of debt (a 50% LTV), with a
liquidation threshold of `0.85`, a deleverage threshold of `1.20` and a
target of `1.40`:

| Scenario                         | Path                                                  | Outcome                                                                                  |
| -------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `steady-positive-yield`          | 10% yield per tick, no interest, price flat at `1.00` | Debt repaid in full after 10 ticks; all 1000 collateral kept                             |
| `yield-collapse`                 | 5% yield for 2 ticks then 0%, 0.1% interest per tick  | 50 repaid, then repayment stalls; debt stays open, no liquidation                        |
| `collateral-drawdown-deleverage` | Price drops from `1.00` to `0.65` and stays there     | Auto-deleverage sells some collateral; health factor stays at or above `1.0`             |
| `collateral-collapse`            | Price at `0.30` from the first tick                   | Deleverage sells all 1000 collateral, 195 of debt remains, position liquidated on tick 0 |

To run only these scenarios:

```bash
pnpm --filter @meridian/strategies test -- scenario-runner
```

### Run your own scenario

Create a test file next to the runner, for example
`packages/strategies/src/my-scenario.test.ts`:

```ts
import { describe, it } from "vitest";
import { Decimal } from "./decimal";
import { LiquidationParameterModel } from "./models/liquidation-parameter";
import { SelfRepayingLoanRunner, type MarketTick } from "./scenario-runner";

describe("my self-repaying loan scenario", () => {
  it("prints the run report", () => {
    const runner = new SelfRepayingLoanRunner({
      collateralAsset: "USDC",
      borrowAsset: "USDG",
      initialCollateralAmount: Decimal.fromString("1000"),
      initialBorrowAmount: Decimal.fromString("500"),
      // maxLoanToValue, liquidationThreshold, liquidationPenalty
      liquidationModel: new LiquidationParameterModel(
        Decimal.fromString("0.80"),
        Decimal.fromString("0.85"),
        Decimal.fromString("0.05")
      ),
      deleverageThresholdHf: Decimal.fromString("1.20"),
      deleverageTargetHf: Decimal.fromString("1.40"),
    });

    // 12 ticks: 1% yield and 0.5% interest per tick, price sliding 6% a tick.
    const ticks: MarketTick[] = Array.from({ length: 12 }, (_, i) => ({
      timestamp: i * 86_400,
      collateralPrice: Decimal.fromString((1 - 0.06 * i).toFixed(2)),
      yieldRate: Decimal.fromString("0.01"),
      borrowInterestRate: Decimal.fromString("0.005"),
    }));

    const report = runner.runScenario("sliding-price", ticks);

    console.table(
      report.snapshots.map((s) => ({
        tick: s.tick,
        price: s.collateralPrice.toString(),
        collateral: s.collateralAmount.toString(),
        debt: s.debt.toString(),
        hf: s.healthFactor?.toString() ?? "none",
        repaid: s.yieldRepaidDebt.toString(),
        sold: s.deleveragedCollateral.toString(),
      }))
    );
    console.log({
      finalCollateral: report.finalCollateral.toString(),
      finalDebt: report.finalDebt.toString(),
      totalYieldRepaid: report.totalYieldRepaid.toString(),
      totalDeleveragedCollateral: report.totalDeleveragedCollateral.toString(),
      isFullyRepaid: report.isFullyRepaid,
      wasLiquidated: report.wasLiquidated,
    });
  });
});
```

Run it. Vitest hides `console` output by default, so pass `--silent=false`:

```bash
pnpm --filter @meridian/strategies exec vitest run my-scenario --silent=false
```

The table and summary look like this (price, collateral, debt, health factor,
debt repaid by yield, and collateral sold, trimmed to the interesting ticks):

```text
tick  price   collateral  debt      hf      repaid  sold
0     1.0000  1000.0000   497.5000  1.7085  5.0000  0.0000
5     0.7000  1000.0000   484.8112  1.2273  5.0000  0.0000
6     0.6400  627.4732    243.8182  1.4000  5.0000  372.5268
7     0.5800  627.4732    240.0373  1.2887  5.0000  0.0000
8     0.5200  440.7975    139.1661  1.4000  5.0000  186.6757
11    0.3400  291.3450    66.1090   1.2736  5.0000  0.0000

finalCollateral: 291.3450442   finalDebt: 66.1090011
totalYieldRepaid: 60.0000000   totalDeleveragedCollateral: 708.6549558
isFullyRepaid: false           wasLiquidated: false
```

Read it like this: through tick 5 the price slide pushes the health factor
down toward the `1.20` trigger while yield barely dents the debt. At tick 6
the health factor would be below `1.20`, so the runner sells 372.5 of
collateral and repays debt until the health factor is back at `1.40`. The
same thing happens at ticks 8 and 10. The loan survives, but 708.7 of the
1000 collateral was sold into a falling market, and yield repaid only 60 of
the debt. The rest was repaid by selling collateral.

Delete the file when you are done; it is a scratch scenario, not part of the
suite.

### What the runner does each tick

For every `MarketTick` (`timestamp`, `collateralPrice`, `yieldRate`,
`borrowInterestRate`), in this order:

1. **Interest.** `debt += debt × borrowInterestRate`.
2. **Yield.** While debt is open, yield is
   `initialBorrowAmount × yieldRate`. It is computed on the original borrowed
   principal, not compounded, and it stops once the debt reaches zero.
3. **Amortize.** The yield repays debt, up to the debt outstanding. Yield
   above the remaining debt on the final repaying tick is counted as earned
   but not as repaid.
4. **Auto-deleverage.** If the health factor is below
   `deleverageThresholdHf`, collateral is sold to bring it back to
   `deleverageTargetHf`, as described above.
5. **Liquidation check.** If the health factor is still below `1.0`, the tick
   is marked liquidated and the run stops after recording it.

A collateral price of zero or below, or a negative borrow rate, throws a
`RangeError` naming the tick.

### Reading the run report

`runScenario` returns a `BacktestReport`:

| Field                        | Meaning                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `scenarioName`               | The name passed to `runScenario`                                        |
| `initialCollateral`          | Collateral at the start of the run                                      |
| `initialDebt`                | Debt at the start of the run                                            |
| `finalCollateral`            | Collateral left after any deleveraging                                  |
| `finalDebt`                  | Debt left at the end; zero when fully repaid                            |
| `totalYieldEarned`           | Sum of yield accrued across ticks                                       |
| `totalYieldRepaid`           | Part of that yield that actually repaid debt                            |
| `totalDeleveragedCollateral` | Collateral sold by auto-deleverage over the run                         |
| `isFullyRepaid`              | `true` when `finalDebt` is zero                                         |
| `wasLiquidated`              | `true` when any tick ended below a health factor of `1.0`               |
| `snapshots`                  | One `TickSnapshot` per tick processed (fewer if the run was liquidated) |

Each `TickSnapshot` records the state after that tick: `collateralAmount`,
`collateralPrice`, `collateralValue`, `debt`, `healthFactor` (undefined once
debt is zero), `accruedYield`, `yieldRepaidDebt`, `deleveragedCollateral`,
and `isLiquidated`.

How to read it:

- **A healthy run** ends with `isFullyRepaid: true`,
  `wasLiquidated: false`, and `totalDeleveragedCollateral` at zero: the
  borrower kept all their collateral and the debt is gone.
- **A stalled run** has `isFullyRepaid: false` without liquidation. Compare
  `totalYieldRepaid` with `initialDebt`, and look for the tick where
  `accruedYield` drops: that is where the yield source stopped carrying the
  loan.
- **A run that deleveraged** has a non-zero `totalDeleveragedCollateral`.
  That collateral is gone for good even if the loan later repays; the
  snapshots with a non-zero `deleveragedCollateral` show when it was sold and
  at what price.
- **A liquidated run** has `wasLiquidated: true` and its last snapshot is the
  liquidation tick. `finalDebt` there is debt that the collateral could not
  cover.

## Related

- `packages/strategies/src/self-repaying-loan.ts`: strategy core (open,
  amortize, close, LTV and health factor).
- `packages/strategies/src/config.ts`: configuration types and validation.
- `packages/strategies/src/monitor.ts`: health factor monitor and
  auto-deleverage sizing.
- `packages/strategies/src/scenario-runner.ts`: the backtest runner and its
  report types.
- [Delta-neutral strategy](./delta-neutral.md): the other simulated strategy
  in the same package.
