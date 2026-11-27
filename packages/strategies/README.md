# @meridian/strategies

Strategy engine and simulation library for Meridian.

## Simulation boundary

The engine runs simulations. It may read market data over RPC, and it may not
sign or submit a transaction, so an unlaunched strategy cannot reach real funds.

`assertSimulationOnly` and `guardStrategyAction` throw
`StrategyIsolationViolationError` before any signing or submission call.
`guard.test.ts` also scans the package's own sources and fails the suite if a
signing or submission API, a deployed contract address, or the
`CONTRACT_ADDRESSES` table appears in them.

Live execution stays off unless `MERIDIAN_STRATEGIES_LIVE_EXECUTION` is exactly
`true`. That variable is the single place a launch flips the boundary, and any
other value leaves the engine in simulation mode.

## Simulated venues and yield

Strategies can use `VenueOrder` operations to deploy an asset amount to a
named venue, harvest accrued yield, or withdraw principal. The runner tracks
principal and yield in a `VenueLedger`; `context.venues` exposes a read-only
`VenuePortfolioView`, and venue positions are included in portfolio valuation.
Declare a strategy that emits these operations as `VenueStrategy<TConfig>`;
the default `Strategy<TConfig>` order type remains spot-only.
Withdrawals can specify a principal amount; omitting it withdraws all
principal. A withdrawal also returns all yield accrued at that venue, even
when principal withdrawal is partial. A harvest can instead reduce an
explicitly opened simulation-only linked debt; any amount beyond that debt is
credited to cash.

Configure simulated venue yields with `accrual.venueRates`, keyed by venue ID.
Each venue may use either a non-negative `ratePerSecond` or a non-negative
`annualRate` (not both). Annual rates accrue on a 365-day year. Yield accrual
uses fixed-point arithmetic and carries fractional-stroop remainders between
ticks. Venue operations are charged the configured per-operation network fee.

This is accounting and yield simulation only. A venue ID is a label, not a
protocol adapter or live connection; the model contains no venue addresses,
signing, or transaction submission.

## Delta-neutral supply and borrow carry

`DeltaNeutralConfig` (and the `delta-neutral` registry params) accept optional
non-negative annualized `supplyRate` and `borrowRate` inputs (365-day year,
defaulting to `0`):

- **Supply interest** accrues each step on the long spot leg's opening quote
  notional (`spotQuantity × lastPrice`).
- **Borrow interest** accrues each step on the borrowed portion of each
  leveraged leg (`max(0, longNotional − longMargin) + max(0, shortNotional − shortMargin)`).
- The net spread is accrued in fixed-point stroops with a carried
  fractional-stroop remainder, exposed as `carryPnl` on the strategy and
  `DeltaNeutralSnapshot`, and included in `totalPnl` and `equity`.
- Omitting both rates or setting them to `0` leaves results unchanged.

## Fixed-point math

Monetary values use `Decimal`, a fixed-point type backed by `bigint` that stores
a value as `raw / 10^scale`. The default scale is 7, matching Stellar stroops.

```ts
import { Decimal } from "@meridian/strategies";

const a = Decimal.fromString("100.25");
const b = Decimal.fromStroops(500_000_000n); // 50.0000000
a.add(b).toString(); // "150.2500000"
```

Rounding rules:

- An operation aligns both operands to the wider of their two scales first, so
  no operand is rounded before the operation runs. The result carries that
  wider scale.
- `add` and `sub` are exact. `mul` and `div` round once, at the result scale,
  with the mode passed in (default `half-up`).
- Comparisons compare aligned values exactly and are symmetric across scales.
- `toStroops()` rescales to scale 7 and rounds `half-up`, so a value held at a
  finer scale loses precision on conversion.

A `bigint` operand is raw units at the receiver's scale. A `string` operand is
a decimal literal, taken at its exact value.

## Scenario costs

Scenarios may include run-wide execution assumptions as non-negative,
fixed-point decimal strings with at most seven fractional digits:

```json
{
  "schemaVersion": 2,
  "costs": {
    "swapFeeRate": "0.003",
    "networkFee": "0.0000100"
  }
}
```

Omitting `costs` applies zero costs. Version 1 scenarios remain valid and
receive the same zero-cost default; scenarios created with the current schema
use version 2.

## Golden scenario fixture

`test-fixtures/scenario-golden.json` pins the full state and order sequence of
one self-repaying loan run, so an unintended change to interest accrual,
amortisation, or close behaviour fails the suite instead of passing quietly.

To regenerate it after an intentional change, run
`UPDATE_GOLDEN=true pnpm --filter @meridian/strategies test` and review the diff
before committing. The suite refuses to regenerate under `CI`, so a stale
fixture can never be blessed by a pipeline run.

## Running the example

A minimal simulation-only strategy and matching scenario live in [`examples/`](./examples):

- [`examples/target-weight-strategy.ts`](./examples/target-weight-strategy.ts): implements `Strategy<TargetWeightConfig>` and a matching `StrategyDefinition`.
- [`examples/target-weight.scenario.json`](./examples/target-weight.scenario.json): deterministic synthetic scenario.
- [`scripts/run-example.ts`](./scripts/run-example.ts): parses the scenario, resolves the strategy, runs the backtest, and prints a deterministic JSON summary.

```bash
pnpm --filter @meridian/strategies build
pnpm --filter @meridian/strategies example
```

## Installation

```bash
pnpm add @meridian/strategies
```

## License

MIT
