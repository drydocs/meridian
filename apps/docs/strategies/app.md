# Strategies app user guide

The Strategies app is a separate interface for exploring Meridian's strategy
simulation engine. **It is simulation-only:** it cannot connect a signer, sign
or submit transactions, or access live vault funds.

> **Current app status:** the app provides its header, a simulation notice, and
> three navigation tabs: **Single Run**, **Run History**, and **Comparison**.
> **Single Run** has a scenario form with synthetic market-regime presets,
> simulation controls, and a summary for completed runs. **Run History** and
> **Comparison** are empty states: runs are not saved or compared. The app does
> not currently provide result charts, an in-app risk panel, or an opportunity
> scanner.

## What the app does

The app is a frontend for the strategy engine in
[`@meridian/strategies`](https://github.com/drydocs/meridian/tree/main/packages/strategies).
The engine provides deterministic backtesting and report and risk-metric
utilities. The **Single Run** view exposes scenario configuration and execution,
then shows a summary of a completed run. The app does not load saved results.

The header displays the strategy engine name and version. The **Simulation
only** notice describes the app's safety boundary. Use the tabs to switch
between the three current views:

| Tab             | Current behavior                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single Run**  | Provides a scenario form, regime presets, a run control, and a summary after a successful simulation. Result charts and an in-app risk panel are not available. |
| **Run History** | Shows that no runs are recorded. Saving, opening, deleting, and clearing runs are not available.                                                                |
| **Comparison**  | Shows that there are no runs to compare. Selecting runs, cross-market normalization, and comparison charts are not available.                                   |

The app has no opportunity-scanner view in the current release.

## Run the app locally

From the repository root, install the workspace dependencies if needed:

```bash
pnpm install
```

Start the app's Vite development server:

```bash
pnpm --filter @meridian/strategies-app dev
```

Open `http://localhost:3003` in your browser. The app uses port 3003 and
requires that port to be available.

Build the app and type-check its TypeScript:

```bash
pnpm --filter @meridian/strategies-app build
```

To serve the production build locally:

```bash
pnpm --filter @meridian/strategies-app preview
```

## Scenarios and regime presets

The **Single Run** form lets you configure and execute a simulation. The
engine's scenario schema describes the inputs represented by the form:

| Engine scenario field             | Meaning                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `window.start`, `window.end`      | UTC start and end instants for the run.                                      |
| `window.step`                     | ISO-8601 duration between simulation steps.                                  |
| `assets`                          | Non-empty list of uppercase asset symbols.                                   |
| `source.price`, `source.rate`     | Declared price and rate data sources.                                        |
| `startingCapital`                 | Positive fixed-point decimal string; it is not a floating-point JSON number. |
| `strategy.id`, `strategy.version` | Strategy identity and version.                                               |
| `strategy.params`                 | String-valued strategy parameters.                                           |
| `seed`                            | Non-empty string used to make seeded runs reproducible.                      |

The current schema is strict: unexpected keys are rejected. See the [scenario
and source guides](./delta-neutral.md) and the [self-repaying loan
guide](./self-repaying-loan.md) for engine-level strategy behavior.

The form includes synthetic `trending`, `ranging`, and `high-funding` regime
presets. Selecting a preset fills the scenario fields with that regime's
starting values; you can then edit the fields before running the simulation.

## Results, charts, and risk metrics

After a successful run, the app displays a summary with final value, total
interest, total funding, total fees, and strategy equity. It does not currently
render result charts or an in-app risk panel. The engine provides result
snapshots and risk-metric functions; the descriptions below explain those
engine concepts, not currently rendered app components. For the metric
definitions and sign conventions, see the
[risk-metrics reference](#risk-metrics-reference).

### Value, PnL, cash, and positions

An engine backtest snapshot records portfolio value, cash, and open positions
at a simulation step. In a value series, each point is the portfolio value at
that time. A change in value is not by itself a complete explanation of
performance: inspect cash flows, fees, funding, and the positions alongside
it.

PnL is the change from an explicitly chosen starting value. For a run with
starting value `V₀` and value at step `t` of `Vₜ`, absolute PnL is `Vₜ - V₀`;
percentage PnL is `(Vₜ / V₀) - 1` when `V₀` is positive. These are interpretations of the engine values; the app does not currently
render a value chart.

Cash and position values describe different parts of the portfolio. Cash is
the uninvested balance; positions are holdings marked using the simulation's
prices. Consider both when evaluating total portfolio value.

### Risk-metrics reference

The engine's risk metrics use return and drawdown series. A return is
`value[t] / value[t - 1] - 1`. A drawdown is `value[t] / runningPeak[t] - 1`.
Returns can become positive during a recovery while drawdown remains negative
until the prior peak is regained.

| Metric                               | Engine convention                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maximum drawdown**                 | Worst peak-to-trough decline reported as a **non-negative loss magnitude**. A 2% decline is `0.02`, not `-0.02`.                                                                                                                                                                                |
| **Sharpe ratio**                     | Mean excess return divided by return standard deviation. `sharpeRatio` returns a per-period value; `annualizeSharpe` separately scales it by the square root of periods per year. A positive ratio means positive average excess return; a negative ratio means negative average excess return. |
| **Historical value at risk (VaR)**   | The selected lower-tail return is negated, so a **positive value means a loss**. A negative VaR means the selected tail observation is a gain. The engine's combined metric helper defaults to 95% confidence.                                                                                  |
| **Conditional value at risk (CVaR)** | Mean of the returns at or below the VaR threshold, negated like VaR, so a positive value is a loss. Never a smaller loss than VaR.                                                                                                                                                              |
| **Sortino ratio**                    | Excess mean over the downside deviation, which counts only returns below a minimum acceptable return (default 0). `null` from `computeRiskMetrics` when no return falls below it.                                                                                                               |
| **Calmar ratio**                     | Arithmetically annualized mean return divided by the maximum drawdown. `null` from `computeRiskMetrics` when the drawdown is zero.                                                                                                                                                              |

The Sharpe calculation defaults to population variance and a zero per-period
risk-free rate. It needs at least two returns and a non-zero variance. VaR
requires a non-empty return series and a confidence level strictly between zero
and one. The app does not currently display these metrics or provide controls
for their assumptions.

For the metric implementations and edge cases, see the engine's
[`risk-metrics.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/risk-metrics.ts).
An in-app risk panel and a separate docs glossary are not present in the
current app/docs build.

## Run history and comparison

The current **Run History** and **Comparison** tabs are placeholders. The app
does not currently save runs, reopen a report, delete one run, clear a history,
or compare selected runs. It also has no cross-market normalization model.

Until comparison support is available, treat values from different assets,
currencies, time windows, or simulation assumptions as not directly
comparable. The app currently performs no normalization to make such runs
comparable.

## Opportunity scanner

There is no opportunity scanner in the current app. It does not scan markets,
rank opportunities, or display a ranking formula.

## Simulation-only boundary

The app is separate from Meridian's live vault interface. It does not connect
to a wallet or signer, sign or submit a transaction, call a live vault, or
manage deposits. Its results are simulations from the strategy engine, not
offers, guarantees, or records of live execution.

For engine behavior, see the [delta-neutral strategy](./delta-neutral.md),
[self-repaying loan strategy](./self-repaying-loan.md), and
[strategy composition](./composition.md) guides.
