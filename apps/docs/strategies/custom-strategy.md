# Add a custom strategy

This tutorial follows one small spot strategy from its idea to a typed,
registered, tested backtest. The example watches a simulated asset price and
buys once when the price is at or below a configured entry threshold. It holds
the position until the run ends.

Strategies in `@meridian/strategies` are simulation components: they observe a
market and portfolio view, then return intended orders for the backtest runner
to fill. They do not submit transactions or execute against live venues. For
the wider package layout, start with the
[architecture overview](../architecture/monorepo).

## 1. Implement the strategy contract

Every strategy implements `Strategy<TConfig>`:

- `init` is called once with starting capital and the parsed, typed config.
- `step` observes each tick and can update internal bookkeeping.
- `rebalance` runs after `step` at each tick and returns intended orders.
- `close` runs once after the final tick and returns any orders needed to
  unwind.

The strategy receives only `StrategyContext`: a timestamp, prices and a
read-only `PortfolioView`. It cannot mutate the portfolio itself. The runner
applies returned orders as simulated fills.

`StrategyLifecycle` is the checked boundary around these calls. It requires
`init` first, then one `step` followed by one `rebalance` for each strictly
increasing tick, and finally `close` at run end (after init or a completed
tick). Calling methods
out of order or reusing a timestamp throws `LifecycleOrderError`. The
`runBacktest` runner drives strategies through this guard, so tests should too
when exercising lifecycle behavior.

Here is the complete example strategy. It reserves 0.5% of its starting cash
for modeled execution costs, buys only once after the entry condition is met,
and sells its portfolio position on close:

```typescript
import { FixedPointDecimal, STROOPS_PER_UNIT } from "@meridian/strategies";
import type {
  AssetSymbol,
  Order,
  Strategy,
  StrategyContext,
  StrategyInitParams,
} from "@meridian/strategies";

export interface ThresholdSpotConfig {
  readonly asset: AssetSymbol;
  readonly entryPrice: FixedPointDecimal;
}

const BPS_DENOMINATOR = 10_000n;
const ENTRY_HEADROOM_BPS = 50n;

export class ThresholdSpotStrategy implements Strategy<ThresholdSpotConfig> {
  readonly name = "threshold-spot";
  #asset: AssetSymbol | null = null;
  #entryPrice: FixedPointDecimal | null = null;
  #startingCapital = 0n;
  #entered = false;

  init(params: StrategyInitParams<ThresholdSpotConfig>): void {
    this.#asset = params.config.asset;
    this.#entryPrice = params.config.entryPrice;
    this.#startingCapital = params.startingCapital.toStroops();
    this.#entered = false;
  }

  step(_context: StrategyContext): void {
    void _context;
  }

  rebalance(context: StrategyContext): readonly Order[] {
    if (this.#entered || this.#asset === null || this.#entryPrice === null) {
      return [];
    }

    const price = context.market.prices.get(this.#asset);
    if (
      price === undefined ||
      price.toStroops() <= 0n ||
      price.compareTo(this.#entryPrice) > 0
    ) {
      return [];
    }

    const spendable =
      (this.#startingCapital * (BPS_DENOMINATOR - ENTRY_HEADROOM_BPS)) /
      BPS_DENOMINATOR;
    const size = (spendable * STROOPS_PER_UNIT) / price.toStroops();
    if (size === 0n) return [];

    this.#entered = true;
    return [
      {
        asset: this.#asset,
        size: FixedPointDecimal.fromStroops(size),
        reason: "entry threshold reached",
      },
    ];
  }

  close(context: StrategyContext): readonly Order[] {
    if (this.#asset === null) return [];
    const position = context.portfolio.getPosition(this.#asset);
    if (position === undefined || position.size.toStroops() === 0n) return [];

    return [
      {
        asset: this.#asset,
        size: FixedPointDecimal.fromStroops(-position.size.toStroops()),
        reason: "close at end of simulation",
      },
    ];
  }
}
```

Keep decision logic deterministic: use values passed through `StrategyContext`
and the configured seed/data, not wall-clock time, random globals, network
responses, or mutable process-wide state.

## 2. Parse scenario params into typed config

Scenario params are strings by design. Convert them once, at the registry
boundary, into the config your class expects. Reject missing, malformed, and
unknown keys with `StrategyParamsError`; do not silently substitute defaults.
Money and rate strings use fixed-point precision (up to seven fractional
digits), not JavaScript floating-point numbers.

The registry's existing `readAsset`, `readDecimal`, and
`rejectUnknownKeys` helpers are module-local. Add the definition in
`packages/strategies/src/registry.ts` to use those same validators:

```typescript
export const THRESHOLD_SPOT_ID = "threshold-spot";

const thresholdSpotDefinition = defineStrategy<ThresholdSpotConfig>({
  id: THRESHOLD_SPOT_ID,
  version: STRATEGY_VERSION_1,
  create: () => new ThresholdSpotStrategy(),
  parseParams(params) {
    rejectUnknownKeys(THRESHOLD_SPOT_ID, params, ["asset", "entryPrice"]);
    const asset = readAsset(THRESHOLD_SPOT_ID, params, "asset");
    const entryPrice = readDecimal(THRESHOLD_SPOT_ID, params, "entryPrice");
    if (entryPrice.toStroops() <= 0n) {
      throw new StrategyParamsError(
        THRESHOLD_SPOT_ID,
        "entryPrice",
        "must be strictly positive"
      );
    }
    return { asset, entryPrice };
  },
});
```

Complete the registration in that file: import `ThresholdSpotStrategy` and
`ThresholdSpotConfig`, include `StrategyDefinition<ThresholdSpotConfig>` in
`RegisteredDefinition`, add `thresholdSpotDefinition` to the frozen
`STRATEGY_DEFINITIONS` array, and add an overload and return-union member for
`resolveStrategy`. The overload maps the literal strategy ID to the matching
config type. Keep a fresh instance in `create()`; strategy state must not leak
between backtests.

## 3. Declare the scenario

`ScenarioSchema` requires a window, assets, both source selectors, starting
capital, strategy identity and params, and a non-empty reproducibility seed.
The source object has two fields:

- `source.price` describes the selected price source (`horizon` or
  `defillama`).
- `source.rate` describes the selected rate source (`blend` or `defindex`).

These are scenario metadata and validation inputs; `parseScenario` does not
fetch either source. The backtest caller still supplies a `PriceFeed` to
`runBacktest`. This spot example does not use a yield rate, but the schema
currently still requires `source.rate`.

The example's matching scenario is:

```yaml
schemaVersion: 1
window:
  start: "2024-01-01T00:00:00Z"
  end: "2024-01-01T02:00:00Z"
  step: "PT1H"
assets:
  - USDC
source:
  price: horizon
  rate: blend
startingCapital: "1000"
strategy:
  id: threshold-spot
  version: 1.0.0
  params:
    asset: USDC
    entryPrice: "95"
seed: threshold-spot-example-v1
```

The source field names and allowed values are defined by
`ScenarioSourceSchema`; the strategy's own keys are parsed by its registered
definition. Use `parseScenario` before resolving the strategy so malformed
scenario input fails with a field-qualified `ScenarioValidationError`.

## 4. Run it through `runBacktest`

Build an explicit clock and price feed for the scenario window, resolve the
scenario's strategy params, and pass the result to `runBacktest`. This example
uses deterministic marks of 100, 90, and 110: the strategy waits at the first
tick, enters at 90, and closes at the final mark.

```typescript
import {
  BacktestPriceFeed,
  FixedPointDecimal,
  ONE_HOUR_MS,
  SimulationClock,
  THRESHOLD_SPOT_ID,
  parseScenario,
  resolveStrategy,
  runBacktest,
} from "@meridian/strategies";
import type { BacktestResult } from "@meridian/strategies";

function runThresholdScenario(): {
  result: BacktestResult;
  fills: string[];
} {
  const scenario = parseScenario({
    schemaVersion: 1,
    window: {
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-01T02:00:00Z",
      step: "PT1H",
    },
    assets: ["USDC"],
    source: { price: "horizon", rate: "blend" },
    startingCapital: "1000",
    strategy: {
      id: THRESHOLD_SPOT_ID,
      version: "1.0.0",
      params: { asset: "USDC", entryPrice: "95" },
    },
    seed: "threshold-spot-example-v1",
  });

  const { strategy, config } = resolveStrategy(
    THRESHOLD_SPOT_ID,
    scenario.strategy.version,
    scenario.strategy.params
  );
  const start = Date.parse(scenario.window.start);
  const clock = new SimulationClock({
    start,
    end: Date.parse(scenario.window.end),
    stepMs: ONE_HOUR_MS,
  });
  const prices = BacktestPriceFeed.create({
    USDC: [
      { timestamp: start, price: "100" },
      { timestamp: start + ONE_HOUR_MS, price: "90" },
      { timestamp: start + 2 * ONE_HOUR_MS, price: "110" },
    ],
  });

  const fills: string[] = [];
  const result = runBacktest({
    clock,
    assets: [config.asset],
    prices,
    strategy,
    strategyConfig: config,
    initialCash: FixedPointDecimal.fromString(scenario.startingCapital),
    observer: { onFill: ({ size }) => fills.push(size.toString()) },
  });
  return { result, fills };
}
```

The runner calls `init`, applies accrued costs if configured, then calls
`step` and `rebalance` at each clock tick. It applies returned orders to the
portfolio, records snapshots, and calls `close` after the last tick. This
strategy only uses the runner's portfolio, so its equity is accounted for by
the portfolio; strategies that track positions outside it must implement
`EquityReportingStrategy` for the runner's separate `strategyEquity` result.
The last snapshot is recorded before close orders are filled; `finalValue`
includes those closing fills.

## 5. Test decisions and a scenario backtest

Keep unit tests small and deterministic. Cover threshold-not-reached,
threshold-reached, no duplicate entry, and closing an open position. Test
parameter parsing for missing, invalid, and unknown keys. A lifecycle test
can wrap the strategy in `StrategyLifecycle` and assert that an out-of-order
call throws `LifecycleOrderError`.

For the scenario test, run the parsed scenario twice with fresh strategy,
clock, and feed instances. Assert the entry occurs on the expected tick, the
close leaves the portfolio in cash, and serialized snapshots match:

```typescript
import { describe, expect, it } from "vitest";
import { serializeSnapshots } from "@meridian/strategies";

describe("threshold spot scenario", () => {
  it("replays the same scenario deterministically", () => {
    const firstRun = runThresholdScenario();
    const secondRun = runThresholdScenario();
    const first = firstRun.result;
    const second = secondRun.result;

    expect(first.strategyName).toBe("threshold-spot");
    expect(first.snapshots).toHaveLength(3);
    expect(first.snapshots[0]?.positions).toHaveLength(0);
    expect(first.snapshots[1]?.positions[0]?.asset).toBe("USDC");
    expect(firstRun.fills).toEqual(["11.0555555", "-11.0555555"]);
    expect(serializeSnapshots(second.snapshots)).toBe(
      serializeSnapshots(first.snapshots)
    );
  });
});
```

In a package test, import `ThresholdSpotStrategy` and its config from the
module where you placed them; the tutorial snippets show the relevant pieces,
not a second API surface.

## Portfolio trades versus venues and yield sources

The example expresses every trade as an `Order` against an asset in the
runner's `Portfolio`. That is enough for spot strategies: the runner prices
the asset, applies simulated fills, tracks the position, and includes it in
portfolio value.

A strategy that deploys capital to a venue, accrues yield there, or harvests
yield needs a venue/yield-source model; it should not disguise a venue balance
as a synthetic spot asset. The current strategy `Order` and portfolio do not
model those operations. Follow [#1250, Model venues and yield sources in the
strategy engine](https://github.com/drydocs/meridian/issues/1250) for that
extension. Until that model is available, keep venue behavior out of a
`Strategy<TConfig>` implementation that runs through this portfolio-only
harness.

## Keep the simulation boundary

Keep strategies pure with respect to external systems: do not add wallet
signing, transaction submission, protocol adapters, or live order routing.
Market data and rates must enter as explicit simulation inputs, and trading
intent must leave as returned orders for the deterministic harness. The
strategies package's simulation guard is in
[`packages/strategies/src/guard.ts`](../../../packages/strategies/src/guard.ts);
follow it when adding actions around a strategy. This tutorial's example only
uses the local clock, supplied feed, and simulated portfolio.
