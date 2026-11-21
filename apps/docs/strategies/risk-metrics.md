# Risk metrics

Meridian's strategies package computes risk metrics from backtest returns and
drawdowns. A move of 2% is represented as `0.02`.

## Return and drawdown series

A period return compares portfolio value with its value at the previous step.
For a positive previous value, `return[t] = value[t] / value[t - 1] - 1`.
A drawdown compares the same value with the running peak through that step.
For a positive peak, `drawdown[t] = value[t] / peak[t] - 1`.
Returns can be positive during a recovery while drawdown remains negative.

## Maximum drawdown

`maxDrawdown` reports the worst decline as a non-negative fraction of the running peak.
[Source](https://github.com/drydocs/meridian/blob/fa4e674f6818d4498cd080111c172297d84eaa32/packages/strategies/src/risk-metrics.ts#L141)

```text
maximum drawdown = -min(0, drawdown[1], ..., drawdown[n])
```

A worst drawdown of `-0.02` yields `0.02`, or a 2% peak-to-trough loss.
An empty series or a series that stays at its peak yields zero.

## Per-period Sharpe ratio

`sharpeRatio` reports mean excess return per unit of return dispersion for one period.
[Source](https://github.com/drydocs/meridian/blob/fa4e674f6818d4498cd080111c172297d84eaa32/packages/strategies/src/risk-metrics.ts#L45)

```text
mean = sum(returns) / n
variance = sum((return[i] - mean)^2) / divisor
Sharpe = (mean - riskFreePerPeriod) / sqrt(variance)
```

Here `n` is the number of returns. Population variance uses `divisor = n` by
default. Set `varianceMode` to `"sample"` to use
`divisor = n - 1`. The risk-free input defaults to zero and uses the same period
as the returns. Convert an annual risk-free rate to the return period before
passing it in. The ratio is unitless, with the same sign as the excess mean.
The function throws `RangeError` for fewer than two returns or a computed
variance of zero.

## Annualized Sharpe ratio

`annualizeSharpe` scales a per-period Sharpe ratio using the convention for independent, identically distributed periods.
[Source](https://github.com/drydocs/meridian/blob/fa4e674f6818d4498cd080111c172297d84eaa32/packages/strategies/src/risk-metrics.ts#L82)

```text
annualized Sharpe = per-period Sharpe * sqrt(periodsPerYear)
```

The caller supplies `periodsPerYear`. When the series has one return per fixed
scenario step, get `stepMs` from `durationToMilliseconds(scenario.window.step)`.
For a 365-day year, `periodsPerYear = 365 * 24 * 60 * 60 * 1000 / stepMs`. A daily step gives
365 periods and an hourly step gives 8,760. Use the cadence of the return series
if you aggregate the steps first. The result is unitless and keeps the sign of
the per-period ratio. A non-positive period count throws `RangeError`.

## Historical value at risk

`valueAtRisk` sorts period returns in ascending order. At a confidence level
`c`, it selects a lower-tail observation by its one-based rank.
[Source](https://github.com/drydocs/meridian/blob/fa4e674f6818d4498cd080111c172297d84eaa32/packages/strategies/src/risk-metrics.ts#L106)

```text
k = clamp(ceil((1 - c) * n), 1, n)
VaR = -sortedReturns[k - 1]
```

The ceiling keeps an exact integer rank unchanged and rounds a fractional rank
up. Clamping keeps the observation within the available sample. Rank 1 selects
the worst return and rank `n` selects the best. The calculation uses the selected
observation directly. VaR is a fraction for one return period. Positive VaR
represents a loss, zero represents break-even, and negative VaR means the selected
lower-tail return is positive. An empty return series or confidence outside the
open interval `(0, 1)` throws `RangeError`. The `computeRiskMetrics` helper
defaults to 95% confidence.

## Worked fixed-point example

Take daily portfolio values `1`, `0.98`, `0.9849`, `0.9996735` and `1.03966044`.
The four period returns are `-0.02`, `0.005`, `0.015` and `0.04`. The drawdowns
after those four steps are `-0.02`, `-0.0151`, `-0.0003265` and `0`. Use a
per-period risk-free input of `0.002`.

```ts
import {
  annualizeSharpe,
  computeRiskMetrics,
  Decimal,
  sharpeRatio,
} from "@meridian/strategies";

const decimal = (value: string) => Decimal.fromString(value, 7);
const returns = ["-0.02", "0.005", "0.015", "0.04"].map(decimal);
const drawdowns = ["-0.02", "-0.0151", "-0.0003265", "0"].map(decimal);
const riskFreePerPeriod = decimal("0.002");
const metrics = computeRiskMetrics(drawdowns, returns, { riskFreePerPeriod });

metrics.maxDrawdown.toString(); // "0.020000000000000000"
metrics.sharpeRatio.toFixed(6); // "0.371992"
sharpeRatio(returns, riskFreePerPeriod, "sample").toFixed(6); // "0.322155"
annualizeSharpe(metrics.sharpeRatio, 365).toFixed(6); // "7.106906"
metrics.valueAtRisk.toString(); // "0.0200000"
```

The mean return is `0.01`, the excess mean is `0.008` and the sum of squared
deviations is `0.00185`. Population variance is `0.0004625` and sample variance
is about `0.000616666666666667` at scale 18. At 95% confidence, the tail rank is
`ceil(0.05 * 4) = 1`, so VaR is `-(-0.02) = 0.02`.

Maximum drawdown and both Sharpe calculations use at least 18 decimal places
and keep wider input scales. The Sharpe calculations round multiplication and
division half up, and floor square roots at the working scale. VaR preserves
the scale of the selected observation, which is 7 in this example.
