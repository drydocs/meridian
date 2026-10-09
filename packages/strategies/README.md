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

## Golden scenario fixture

`test-fixtures/scenario-golden.json` pins the full state and order sequence of
one self-repaying loan run, so an unintended change to interest accrual,
amortisation, or close behaviour fails the suite instead of passing quietly.

To regenerate it after an intentional change, run
`UPDATE_GOLDEN=true pnpm --filter @meridian/strategies test` and review the diff
before committing. The suite refuses to regenerate under `CI`, so a stale
fixture can never be blessed by a pipeline run.

## Installation

```bash
pnpm add @meridian/strategies
```

## License

MIT
