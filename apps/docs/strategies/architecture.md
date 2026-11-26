# Strategies architecture overview

This page shows how the pieces of the strategies engine fit together, from a
scenario to a run result. It stays at the architecture level: the focused
guides cover each strategy in depth, and the source files carry the full API
detail.

**Simulation only.** Everything on this page runs inside the deterministic
backtest harness in `@meridian/strategies`. The engine is not wired to a live
venue, a vault, or mainnet funds. It has no signing key, no order router, and
no code that submits a transaction. Every number it produces comes from a
simulated scenario.

## Data flow

A run starts from one validated scenario and ends in a `BacktestResult`. A
caller that wants to store or extend the run records it as a `RunReport`.

```text
Scenario input (untrusted JSON)
  │
  │  parseScenario
  ▼
Scenario
  ├── scenarioClock ──────────► SimulationClock
  ├── resolveScenarioSources ─► prices + accrual
  │     (a synthetic regime uses scenarioPriceFeed instead)
  ├── resolveStrategy ────────► strategy + typed config
  │
  ▼
runBacktest
  │  each tick: accrual → step → rebalance → fills → snapshot
  │  after the last tick: close → fills
  ▼
BacktestResult: snapshots, finalValue, strategyEquity, totals
  │
  │  recorded by the caller
  ▼
RunReport
  ├── serializeReport ────────► stored JSON report
  └── buildWarmStartContext ──► continuation scenario ──► next run
                                (mergeReports joins the two reports)
```

Each step is described below, in the order a run meets it.

## The package and its entry points

The engine lives in
[`packages/strategies`](https://github.com/drydocs/meridian/tree/main/packages/strategies)
and is the workspace package `@meridian/strategies`. It has one entry point,
[`src/index.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/index.ts),
which re-exports every module, so callers import from the package name rather
than from individual files:

```typescript
import {
  parseScenario,
  resolveStrategy,
  runBacktest,
} from "@meridian/strategies";
```

The modules group as follows:

| Area                | Source                                                                          | Main exports                                                                 |
| ------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Strategy contract   | `strategy.ts`                                                                   | `Strategy`, `StrategyLifecycle`, `BuyAndHoldStrategy`                        |
| Scenario schema     | `scenario.ts`                                                                   | `ScenarioSchema`, `parseScenario`, `safeParseScenario`                       |
| Sources             | `scenario-sources.ts`, `historical-loader.ts`, `feeds.ts`                       | `resolveScenarioSources`, `loadHistoricalSeries`, `BacktestPriceFeed`        |
| Synthetic regimes   | `regime-scenarios.ts`, `gbm.ts`                                                 | `buildRegimeScenario`, `scenarioClock`, `scenarioPriceFeed`                  |
| Registry            | `registry.ts`                                                                   | `resolveStrategy`, `STRATEGY_DEFINITIONS`                                    |
| Runner              | `backtest/runner.ts`, `clock.ts`, `accrual.ts`, `slippage-model.ts`, `costs.ts` | `runBacktest`, `SimulationClock`, `applyOrderFill`, `ZERO_COSTS`             |
| Portfolio           | `portfolio.ts`                                                                  | `Portfolio`                                                                  |
| Strategies          | `delta-neutral.ts`, `self-repaying-loan.ts`, `scenario-runner.ts`               | `DeltaNeutralStrategy`, `SelfRepayingLoanStrategy`, `SelfRepayingLoanRunner` |
| Composition         | `composition/`                                                                  | `ComposedStrategy`, `runComposedBacktest`, `allocateCapital`                 |
| Reports             | `report.ts`                                                                     | `RunReport`, `serializeReport`, `buildWarmStartContext`                      |
| Simulation boundary | `guard.ts`                                                                      | `assertSimulationOnly`, `guardStrategyAction`                                |
| Fixed-point math    | `types.ts`, `decimal.ts`                                                        | `FixedPointDecimal`, `Decimal`                                               |

Money and rate values are `bigint`-backed fixed-point decimals, never
JavaScript floats. `FixedPointDecimal` holds seven fractional digits, the
Stellar stroop scale, so the same inputs always produce byte-identical results.
No module makes a network call when it is loaded.

## Strategy lifecycle

Source:
[`strategy.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/strategy.ts)

A strategy implements `Strategy<TConfig>`:

| Member               | Role                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `name`               | Identifies the strategy in a result                               |
| `init(params)`       | Receives `startingCapital` and the typed `config`, once           |
| `step(context)`      | Observes one tick: updates internal state, returns nothing        |
| `rebalance(context)` | Returns the orders the strategy wants at that tick                |
| `close(context)`     | Returns the orders that unwind the strategy at the end of the run |

The `context` holds the tick's `market` (timestamp and a price per asset) and a
read-only `PortfolioView`. A strategy never changes the portfolio itself. It
returns `Order` values (an asset and a signed size, positive to buy, negative
to sell), and the runner applies them as fills.

`StrategyLifecycle` wraps a strategy and turns that order of calls into a
checked contract: `init` once, then `step` and `rebalance` for each tick with
strictly increasing timestamps, then `close` once. An out-of-order call throws
`LifecycleOrderError`. `runBacktest` drives every strategy through this
wrapper.

A strategy can also expose its own `equity` (`EquityReportingStrategy`), for
positions it tracks outside the runner's portfolio. The runner reads it through
`reportedEquity`, as described under [the portfolio and venue
model](#portfolio-and-venue-model).

`BuyAndHoldStrategy` (in `strategy.ts`) and `DeltaNeutralStrategy` implement
this contract. The self-repaying loan is built differently: see
[the backtest runner](#the-backtest-runner).

## Scenario schema

Source:
[`scenario.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/scenario.ts)

A `Scenario` is the single input a run is reproduced from. `ScenarioSchema` is
a `zod` schema with these fields:

| Field             | Shape                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| `schemaVersion`   | `1`, the default when omitted                                         |
| `window`          | `start` and `end` as ISO-8601 UTC instants, `step` as a duration      |
| `assets`          | Non-empty list of uppercase asset symbols, no duplicates              |
| `source.price`    | `horizon` or `defillama`                                              |
| `source.rate`     | `blend` or `defindex`                                                 |
| `startingCapital` | Fixed-point decimal string, greater than zero                         |
| `strategy`        | `id`, `version`, and `params` (a map of string keys to string values) |
| `seed`            | Non-empty string                                                      |

The schema is strict at every level, so an unknown key is an error rather than
a value the engine silently ignores. Money and rate fields are decimal strings
with at most seven fractional digits. A JavaScript `number` is rejected for
them, because binary floating point drifts across the many steps of a run.

`parseScenario(input)` returns a typed `Scenario` or throws a
`ScenarioValidationError` whose message names each offending field (for
example `window.end: window.end must be after window.start`).
`safeParseScenario` returns the same result without throwing.

The scenario does not carry fees or slippage. Those reach a run only through
the `execution` option of `runBacktest`.

## Price and rate sources

Source:
[`scenario-sources.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/scenario-sources.ts),
[`regime-scenarios.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/regime-scenarios.ts)

A scenario names its sources; it does not hold any market data. Two paths turn
it into the feeds a run needs.

### Recorded sources

`resolveScenarioSources(scenario, options)` returns `{ prices, accrual }`:

- **Prices.** For `horizon` and `defillama`, every scenario asset needs a
  recorded price series in `options.historicalData` (rows or streams, loaded by
  `loadHistoricalSeries` from `historical-loader.ts`). The series must cover
  the whole window. The resolver builds a `BacktestPriceFeed` from it.
- **Rates.** The resolver first looks for a recorded rate stream for the
  declared `source.rate`. Without one, it uses the matching DeFiLlama pool's
  APY, taken from `options.defiLlamaPools`, from `options.fetchDeFiLlamaPools`,
  or, as a last resort, from a read-only DeFiLlama pool lookup imported only
  when it is needed. The rate becomes `accrual.cashRateAnnual`, the interest
  earned on idle cash.

Missing or short data throws `MissingSourceDataError`, which names the asset,
the window, and the source. The resolver never fills a gap with a default.

### Synthetic regimes

`regime-scenarios.ts` builds scenarios that need no recorded data.
`buildRegimeScenario(regime, options)` returns a validated scenario for one of
three market regimes: `trending`, `ranging`, or `high-funding`.

Each regime scenario has `strategy.id: "delta-neutral"` and
`strategy.version: STRATEGY_VERSION_1` (`"1.0.0"`), and carries both the
standard delta-neutral parameters (`asset`, `targetLeverage`,
`rebalanceBandBps`, `fundingRatePerSecond`) and the `market.*` regime
parameters (`market.regime`, `market.startPrice`, `market.drift`,
`market.volatility`, `market.fundingRatePerSecond`,
`market.neutralityBandBps`, `market.targetLeverage`) in `strategy.params`. The
schema has no synthetic source option, so `source.price` is recorded as
`horizon`, and `resolveScenarioSources` detects the regime parameters when no
`historicalData` is supplied and builds the price feed from
`scenarioPriceFeed`.

Regime scenarios resolve and run through the standard registry path:
`parseScenario` -> `resolveScenarioSources` -> `resolveStrategy` ->
`runBacktest`. Saved scenarios carrying legacy version `"1"` fail with an
`UnknownStrategyError` migration message directing callers to `"1.0.0"`.

The helpers also expose the individual pieces:

- `scenarioClock(scenario)` builds the `SimulationClock` for the window and
  step. It works for any scenario, not only a regime.
- `scenarioPriceFeed(scenario)` generates a geometric Brownian motion path with
  `generateGbmPath` (`gbm.ts`), seeded from `scenario.seed`, one price per
  clock tick.
- `scenarioFundingRate` and `scenarioDeltaNeutralConfig` build the
  delta-neutral config directly from the scenario.

The same scenario always yields the same path, so a regime run is reproducible
from the scenario alone.

## Strategy registry

Source:
[`registry.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/registry.ts)

The registry maps a scenario's `strategy` block to code. Each
`StrategyDefinition` has an `id`, a `version`, a `create()` constructor, and a
`parseParams(params, dependencies)` function that turns the string `params`
into a typed config. `STRATEGY_DEFINITIONS` ships two definitions:

| `id`            | `version` | `params`                                                              |
| --------------- | --------- | --------------------------------------------------------------------- |
| `buy-and-hold`  | `1.0.0`   | `asset`                                                               |
| `delta-neutral` | `1.0.0`   | `asset`, `targetLeverage`, `rebalanceBandBps`, `fundingRatePerSecond` |

`resolveStrategy(id, version, params, dependencies)` returns
`{ strategy, config }` for an exact `id` and `version` match. An unknown pair
throws `UnknownStrategyError`, which lists the available definitions. A
missing, unknown, or malformed param throws `StrategyParamsError` instead of
falling back to a default.

`dependencies` carries what string params cannot: the price feeds
(`priceFeed`, `hedgeFeed`). The delta-neutral definition requires a
`priceFeed`.

## The backtest runner

Source:
[`backtest/runner.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/backtest/runner.ts)

`runBacktest(config)` runs one strategy, deterministically, over a clock:

| Config field     | Meaning                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `clock`          | `SimulationClock`; every tick from `start` to `end` is visited in order |
| `assets`         | Assets priced on every tick and handed to the strategy                  |
| `prices`         | The `PriceFeed` the assets are priced from                              |
| `strategy`       | The `Strategy` to run                                                   |
| `strategyConfig` | The config passed to `init`                                             |
| `initialCash`    | Starting cash of the portfolio                                          |
| `execution`      | Optional `slippageModel` and `costSchedule`, both zero by default       |
| `accrual`        | Optional cash rate (per second or annual) and funding rate              |
| `observer`       | Optional callbacks for accruals, fills, snapshots and the final state   |

The order of operations inside a tick is part of the result:

1. **Accrual.** Funding on each open position, then interest on idle cash, both
   over the interval since the previous tick and marked at this tick's prices.
   The first tick has no previous interval and accrues nothing.
2. **Strategy.** `step`, then `rebalance`, through `StrategyLifecycle`.
3. **Fills.** Each returned order is priced by `applyOrderFill`, slippage first
   and then costs from the `CostSchedule`, and applied in the order returned.
4. **Snapshot.** Cash, positions and the marked value are recorded.

After the last tick, `close` is called once and its orders are filled the same
way, at the prices of the final tick.

The result is a `BacktestResult`:

| Field            | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `strategyName`   | The strategy's `name`                                               |
| `initialCash`    | The starting cash                                                   |
| `snapshots`      | One `BacktestSnapshot` per tick: `cash`, `positions`, `value`       |
| `finalValue`     | Portfolio value after the closing fills                             |
| `strategyEquity` | The strategy's own equity if it reports one, otherwise `finalValue` |
| `totalInterest`  | Interest earned on idle cash over the run                           |
| `totalFunding`   | Funding paid or received over the run                               |
| `totalFees`      | Fees charged on fills over the run                                  |

`serializeSnapshots` renders the snapshot sequence as byte-stable JSON, which
is how the tests check that two runs of the same scenario are identical.

The self-repaying loan has its own, separate runner: `SelfRepayingLoanRunner`
in `scenario-runner.ts` steps a loan through a list of `MarketTick` rows and
returns its own report. It does not go through `runBacktest`. The
[self-repaying loan guide](./self-repaying-loan.md) describes it.

## Portfolio and venue model

Source:
[`portfolio.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/portfolio.ts),
[`delta-neutral.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/delta-neutral.ts)

`Portfolio` is the runner's ledger. It holds cash and signed positions, keyed
by asset and, inside a composition, by member id. All of its arithmetic is
`bigint` stroops, and it keeps an exact accounting identity:

```text
cash + position value == initial cash + realized + unrealized - fees
```

`applyFill` opens, grows, reduces or closes a position. A single fill that
would flip a position through zero is rejected with `InvalidFillError`.
Accrued interest and funding enter through `applyCashFlow`. Cash may go
negative; the portfolio does not enforce a margin limit.

The runner has no venue object. Every order is filled against the price
feed's mark through `applyOrderFill`, with the configured slippage model and
cost schedule. The only venue model in the package is the delta-neutral hedge:
`ModeledHedgeVenue` is a deterministic ledger of the short hedge notional, with
no network, clock or randomness. That short lives outside the runner's
`Portfolio`, so `finalValue` cannot see it. `DeltaNeutralStrategy` reports its
whole book as `equity`, and the runner surfaces that as `strategyEquity`. The
[delta-neutral guide](./delta-neutral.md) covers the hedge in detail.

## Composition

Source:
[`composition/`](https://github.com/drydocs/meridian/tree/main/packages/strategies/src/composition)

`ComposedStrategy` implements `Strategy<unknown>`, so a group of strategies
runs anywhere a single strategy does, including `runBacktest`. Each member has
an `id`, its own strategy instance and config, and an `allocation`; the
allocations must sum to one. At `init`, `allocateCapital` splits the starting
capital exactly, with largest-remainder apportionment. Each member's orders
are tagged with its id, so two members trading the same asset keep separate
positions. Optional composition constraints are checked at `init` and on
every rebalance.

`runComposedBacktest(config)` runs a composition through `runBacktest` with an
observer and adds an `attribution` to the result:

- per member: `initialCapital`, a value and PnL per snapshot, `finalValue`,
  `pnlContribution`, and `totalFees`;
- `totalPnl` and `totalFees` for the whole composition.

Fills and funding are attributed to the member that owns them, and cash
interest is split by each member's share of cash. The attribution must
reconcile: member values have to add up to each snapshot's value, and member
PnL and fees to the totals, or the run throws. The
[composition guide](./composition.md) walks through a full example.

## Run reports and warm starts

Source:
[`report.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/report.ts)

`runBacktest` returns a `BacktestResult`. A `RunReport` is the separate,
versioned record a caller keeps for a run:

| Field           | Meaning                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | Report format version, `REPORT_FORMAT_VERSION` (`3`)                                                                                    |
| `scenario`      | The validated scenario the run was produced from                                                                                        |
| `engineVersion` | The engine that produced the run                                                                                                        |
| `riskMetrics`   | `maxDrawdown`, `sharpeProxy`, `volatility`, `valueAtRisk`, `conditionalValueAtRisk`, `downsideDeviation`, `sortinoRatio`, `calmarRatio` |
| `eventCounts`   | `rebalances`, `deposits`, `withdrawals`, `priceFeedMisses`                                                                              |
| `finalState`    | Timestamp, holdings per asset, and total value at the end of the run                                                                    |
| `generators`    | The state of each seeded random stream at the start and the end                                                                         |

`serializeReport` and `reportToJSON` write a lossless wire format: every
fixed-point value becomes its stroop count as a decimal string, and generator
states become decimal strings too. `deserializeReport` and `reportFromJSON`
read it back. They reject an unknown format version with
`UnknownReportVersionError`, reject malformed stroop values, and validate the
scenario again with `parseScenario`.

A warm start continues a stored run instead of replaying it:

- `buildWarmStartContext(report, { newEndTimestamp })` returns the report's
  final state, a continuation scenario whose window runs from the report's
  final timestamp to the new end with the final value as its starting
  capital, and the generator states to resume from. The new window must be a
  whole number of steps.
- `restoreGenerators(context)` turns those states back into `XorShift64`
  generators, keyed by stream id.
- `mergeReports(base, continuation, options)` joins the two reports into one
  that spans the full window. It throws if the continuation does not start
  where the base ended, at the same value, with the same engine version,
  scenario settings and generator states.

## Simulation-only boundary

Source:
[`guard.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/src/guard.ts)

The engine may read market data, and it may not sign or submit a transaction.
`assertSimulationOnly(operationName)` is the check a signing or submission
path has to pass: it throws `StrategyIsolationViolationError` naming the
blocked operation. `guardStrategyAction(name, action)` runs that check before
it runs the action. The check passes only when the
`MERIDIAN_STRATEGIES_LIVE_EXECUTION` environment variable is exactly `true`,
which nothing in this repository sets. Any other value, including a missing or
misspelled one, keeps the engine in simulation mode.

The boundary is also checked statically. `guard.test.ts` scans the package's
own source files and fails the suite if a signing or submission API, a
deployed contract address, or the `CONTRACT_ADDRESSES` table appears in them.

## Related

- [Example strategy and CLI](https://github.com/drydocs/meridian/tree/main/packages/strategies/examples):
  a minimal simulation-only `Strategy<TConfig>` implementation
  ([`target-weight-strategy.ts`](https://github.com/drydocs/meridian/blob/main/packages/strategies/examples/target-weight-strategy.ts)),
  matching scenario
  ([`target-weight.scenario.json`](https://github.com/drydocs/meridian/blob/main/packages/strategies/examples/target-weight.scenario.json)),
  and runnable CLI (`pnpm --filter @meridian/strategies example`).
- [Delta-neutral strategy](./delta-neutral.md): the hedged carry strategy and
  its modeled hedge venue.
- [Self-repaying loan strategy](./self-repaying-loan.md): the loan model and
  its per-tick runner.
- [Strategy composition guide](./composition.md): members, constraints,
  capital allocation and attribution.
- [`packages/strategies/README.md`](https://github.com/drydocs/meridian/blob/main/packages/strategies/README.md):
  fixed-point math rules and the golden scenario fixture.
