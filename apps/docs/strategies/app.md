# Strategies app user guide

The Strategies app is a separate interface for exploring Meridian's strategy
simulation engine. **It is simulation-only:** it cannot connect a signer, sign
or submit transactions, or access live vault funds.

> **Current app status:** the app currently provides its header, a simulation
> notice, and three navigation tabs: **Single Run**, **Run History**, and
> **Comparison**. Each tab is an empty state. Scenario editing and execution,
> charts, an in-app risk panel, run storage, run comparison, and the opportunity
> scanner are not available in the current app. This guide describes that
> behavior rather than presenting planned features as usable.

## What the app does

The app is a frontend for the strategy engine in
[`@meridian/strategies`](https://github.com/drydocs/meridian/tree/main/packages/strategies).
The engine provides deterministic backtesting and report and risk-metric
utilities. The current app does not yet expose those engine workflows: opening
it does not start a run or load saved results.

The header displays the strategy engine name and version. The **Simulation
only** notice describes the app's safety boundary. Use the tabs to switch
between the three current views:

| Tab             | Current behavior                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Single Run**  | Shows that no simulation is running. There is no scenario form or run control yet.                                                |
| **Run History** | Shows that no runs are recorded. Saving, opening, deleting, and clearing runs are not available yet.                              |
| **Comparison**  | Shows that there are no runs to compare. Selecting runs, cross-market normalization, and comparison charts are not available yet. |

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

The current app has no scenario form, so scenarios cannot be created or run
from its interface. The engine's scenario schema is useful context for
understanding the inputs that a run requires:

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

The engine also defines synthetic `trending`, `ranging`, and `high-funding`
regimes. They are engine utilities, not selectable presets in the current app.
No scenario form is available to choose or customize them from the UI.

## Results, charts, and risk metrics

There are no result charts or risk panel in the current app. The engine does
provide result snapshots and risk-metric functions; the descriptions below
explain those engine concepts, not currently rendered app components. For the
metric definitions and sign conventions, see the
[risk-metrics reference](#risk-metrics-reference).

### Value, PnL, cash, and positions

An engine backtest snapshot records portfolio value, cash, and open positions
at a simulation step. In a value series, each point is the portfolio value at
that time. A change in value is not by itself a complete explanation of
performance: inspect cash flows, fees, funding, and the positions alongside
it.

PnL is the change from an explicitly chosen starting value. For a run with
starting value `V₀` and value at step `t` of `Vₜ`, absolute PnL is `Vₜ - V₀`;
percentage PnL is `(Vₜ / V₀) - 1` when `V₀` is positive. These are
interpretations of the engine values, not charts currently displayed by the
app.

Cash and position values describe different parts of the portfolio. Cash is
the uninvested balance; positions are holdings marked using the simulation's
prices. Consider both when evaluating total portfolio value.

### Risk-metrics reference

The engine's risk metrics use return and drawdown series. A return is
`value[t] / value[t - 1] - 1`. A drawdown is `value[t] / runningPeak[t] - 1`.
Returns can become positive during a recovery while drawdown remains negative
until the prior peak is regained.

| Metric                             | Engine convention                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Maximum drawdown**               | Worst peak-to-trough decline reported as a **non-negative loss magnitude**. A 2% decline is `0.02`, not `-0.02`.                                                                                                                                                                                |
| **Sharpe ratio**                   | Mean excess return divided by return standard deviation. `sharpeRatio` returns a per-period value; `annualizeSharpe` separately scales it by the square root of periods per year. A positive ratio means positive average excess return; a negative ratio means negative average excess return. |
| **Historical value at risk (VaR)** | The selected lower-tail return is negated, so a **positive value means a loss**. A negative VaR means the selected tail observation is a gain. The engine's combined metric helper defaults to 95% confidence.                                                                                  |

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
