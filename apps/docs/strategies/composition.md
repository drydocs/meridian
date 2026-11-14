# Strategy composition guide

Composition allows multiple strategies to operate over a shared capital ledger,
treating an ensemble of strategies as a single composite investment vehicle.
A composed run behaves as a standard `Strategy` while preserving per-member
accounting, risk constraints, and return attribution.

**Simulation only.** Strategy composition runs exclusively against the
deterministic backtest harness in `@meridian/strategies`. It is not wired to a
live venue, a vault, or mainnet funds. There is no live execution key, order
router, or external network connectivity. Every number and metric described in
this guide is produced deterministically from simulated scenarios.

## 1. Composition model & interface

In Meridian, composition nests hierarchically: `ComposedStrategy` implements
`Strategy<unknown>`, meaning it can be passed anywhere a standalone `Strategy`
is accepted, including `runBacktest`.

### 1.1 The `ComposedStrategy` contract

A composition pairs constructed member `Strategy` instances with stable member
identifiers, capital weights, and strategy configurations. The member lifecycle
follows a strict deterministic execution order:

1. **`init`**: Receives total allocated capital, computes per-member balances
   via `allocation` weights, and initializes each member strategy sequentially.
2. **`step`**: Driven on each ledger tick. Steps each member in declaration order
   with an isolated `StrategyContext`.
3. **`rebalance`**: Executes on each tick, driving member rebalancing in
   declaration order and tagging orders with member namespaces.
4. **`close`**: Triggers a graceful close of all active member positions at the
   end of the simulation.

```typescript
import type { FixedPointDecimal, Order, Strategy } from "@meridian/strategies";

export interface ComposedStrategyMember<TConfig = unknown> {
  readonly id: string;
  readonly strategy: Strategy<TConfig>;
  readonly allocation: FixedPointDecimal;
  readonly config: TConfig;
}
```

### 1.2 Namespacing and position isolation

`Portfolio` keys positions by asset. When two members trade the same asset (for
example, two strategies holding `USDC` or `XLM`), naive tracking would cause
state collisions.

`ComposedStrategy` resolves this by namespacing every position under a compound
key using the member's identifier. Nested compositions concatenate identifiers
using `/` (e.g. `outer/inner`). Each member receives a `MemberPortfolioView`
containing only its own positions, while cash and total portfolio valuation
remain consistent views of the shared ledger.

### 1.3 Composition constraints

`ComposedStrategy` optionally accepts composition-wide limits. The validator
checks the post-trade composition, meaning current positions plus the orders
returned by members at current marks.

```typescript
const composed = new ComposedStrategy(members, {
  constraints: {
    maxMemberCount: 4,
    maxMemberWeight: FixedPointDecimal.fromString("0.6"),
    maxAggregateExposure: FixedPointDecimal.fromString("0.5"),
    minCashBuffer: FixedPointDecimal.fromString("0.1"),
  },
  mode: "reject",
});
```

| Constraint             | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `maxMemberWeight`      | Maximum share of total value in one member's gross positions   |
| `maxAggregateExposure` | Maximum share of total value in one asset across all members   |
| `maxMemberCount`       | Maximum number of members                                      |
| `minCashBuffer`        | Minimum share of total value that remains in cash after orders |

`mode` defaults to `reject`, which throws `CompositionConstraintError` and
names every violation. `mode: "clamp"` trims aggregate-exposure orders to the
available limit. Member-count, member-weight, cash-buffer, and already-breached
exposure limits are rejected because trimming orders cannot guarantee them.

## 2. Capital allocation logic

When initializing members, capital is distributed across members according to
their normalized target weights.

### 2.1 Apportionment and exact capital conservation

`ComposedStrategy` allocates its starting capital with `allocateCapital`,
which uses Hamilton's largest-remainder apportionment to compute exact capital
conservation:

$$\sum \text{Member Capital} = \text{Total Initial Capital}$$

The largest-remainder algorithm operates over `FixedPointDecimal`:

1. **Quota calculation**: Each member receives an exact proportional share:
   $$\text{base}_i = \left\lfloor \frac{\text{total} \times \text{weight}_i}{\sum \text{weights}} \right\rfloor$$
2. **Remainder computation**: The remaining fractional stroops
   $(\text{total} \times \text{weight}_i) \pmod{\sum \text{weights}}$ are sorted
   in descending order.
3. **Deterministic tie-breaking**: When fractional remainders tie, member IDs
   are sorted lexicographically (`leftId < rightId`) to ensure identical results
   regardless of declaration order.
4. **Residual distribution**: One atomic stroop is assigned to the top members
   until all leftover capital is allocated.

```typescript
import { allocateCapital, FixedPointDecimal } from "@meridian/strategies";

const allocations = allocateCapital(FixedPointDecimal.fromString("1000"), [
  { id: "alpha", weight: FixedPointDecimal.fromString("0.70") },
  { id: "beta", weight: FixedPointDecimal.fromString("0.30") },
]);
// allocations[0].amount -> 700 USDC
// allocations[1].amount -> 300 USDC
```

## 3. Composed backtest execution & attribution

`ComposedStrategy` is executed directly using the standard `runBacktest` runner
exported by `@meridian/strategies`.

### 3.1 Granular attribution across snapshots

`runBacktest` records a `BacktestSnapshot` at every ledger tick. Each snapshot
stores:

- `timestamp`: Simulation clock time for the tick.
- `cash`: Liquid cash balance in the shared portfolio.
- `positions`: All open positions, with each position tagged by its `memberId`.
- `value`: Total valuation across all positions priced at current marks.

```typescript
const result = runBacktest({
  clock,
  assets: ["USDC", "XLM"],
  prices,
  strategy: composed,
  strategyConfig: undefined,
  initialCash: FixedPointDecimal.fromString("100000"),
});

// Inspect member positions from any snapshot:
const latestPositions = result.snapshots.at(-1)?.positions ?? [];
for (const pos of latestPositions) {
  console.log(
    `Member: ${pos.memberId}, Asset: ${pos.asset}, Size: ${pos.size}`
  );
}
```

## 4. Correlation matrix of member returns

To evaluate whether a composition provides genuine diversification,
`correlationMatrix` computes the Pearson correlation of member return series.

Given member periodic return vectors $R_i$ and $R_j$:

$$r_{ij} = \frac{\text{Cov}(R_i, R_j)}{\sigma_i \sigma_j}$$

- **Symmetry**: $r_{ij} = r_{ji}$ for all member pairs.
- **Unit diagonal**: $r_{ii} = 1.0$ for all series.
- **Zero-variance handling**: If a member produces constant returns (zero
  variance, such as holding pure cash), standard correlation would divide by
  zero. Meridian returns `undefined` rather than `NaN` for off-diagonal entries,
  preserving numerical integrity.

```typescript
import {
  correlationMatrix,
  Decimal,
  type MemberReturnSeries,
} from "@meridian/strategies";

const memberReturns: MemberReturnSeries[] = [
  {
    id: "alpha",
    returns: [Decimal.fromString("0.02"), Decimal.fromString("0.01")],
  },
  {
    id: "beta",
    returns: [Decimal.fromString("0.01"), Decimal.fromString("0.03")],
  },
];

const matrix = correlationMatrix(memberReturns);
// matrix[0][0] -> 1
// matrix[0][1] -> Pearson correlation Decimal
```

## 5. Worked example: Composed Strategy Simulation

The following complete example demonstrates configuring two members using
`BuyAndHoldStrategy`, executing the composition through `runBacktest`, and
evaluating the resulting positions and correlation matrix.

```typescript
import {
  BuyAndHoldStrategy,
  ComposedStrategy,
  correlationMatrix,
  Decimal,
  FixedPointDecimal,
  type MemberReturnSeries,
  runBacktest,
  SimulationClock,
  StaticPriceFeed,
} from "@meridian/strategies";

const USDC = "USDC";
const XLM = "XLM";
const START_TIME = 1_700_000_000_000;
const ONE_HOUR_MS = 3_600_000;

// 1. Configure deterministic clock and prices
const clock = new SimulationClock({
  start: START_TIME,
  end: START_TIME + ONE_HOUR_MS * 24,
  stepMs: ONE_HOUR_MS,
});

const prices = new StaticPriceFeed(
  new Map([
    [USDC, FixedPointDecimal.fromString("1")],
    [XLM, FixedPointDecimal.fromString("0.12")],
  ])
);

// 2. Define composite strategy with 70/30 capital split
const composed = new ComposedStrategy([
  {
    id: "usdc-reserve",
    strategy: new BuyAndHoldStrategy(),
    allocation: FixedPointDecimal.fromString("0.70"),
    config: { asset: USDC },
  },
  {
    id: "xlm-growth",
    strategy: new BuyAndHoldStrategy(),
    allocation: FixedPointDecimal.fromString("0.30"),
    config: { asset: XLM },
  },
]);

// 3. Execute backtest via the standard runBacktest
const result = runBacktest({
  clock,
  assets: [USDC, XLM],
  prices,
  strategy: composed,
  strategyConfig: undefined,
  initialCash: FixedPointDecimal.fromString("100000"),
});

// 4. Inspect member attribution across snapshots
const firstSnapshot = result.snapshots[0];
console.log("Snapshot positions:", firstSnapshot?.positions);

// 5. Evaluate pairwise return correlation
const memberReturns: MemberReturnSeries[] = [
  {
    id: "usdc-reserve",
    returns: [Decimal.fromString("0.001"), Decimal.fromString("0.001")],
  },
  {
    id: "xlm-growth",
    returns: [Decimal.fromString("0.015"), Decimal.fromString("-0.005")],
  },
];

const matrix = correlationMatrix(memberReturns);
console.log("Member correlation:", matrix[0]?.[1]?.toString());
```

### 5.1 Illustrative performance & attribution breakdown

_(Note: The figures below are illustrative to demonstrate attribution mechanics and fee reporting across members)_

| Metric                 | Reserve Member (`usdc-reserve`) | Growth Member (`xlm-growth`) | Composite Total     |
| :--------------------- | :------------------------------ | :--------------------------- | :------------------ |
| **Initial Allocation** | $70,000.00 (70%)                | $30,000.00 (30%)             | $100,000.00         |
| **Gross Return**       | +$70.00 (+0.10%)                | +$1,500.00 (+5.00%)          | +$1,570.00 (+1.57%) |
| **Trading Fees**       | $0.00                           | -$30.00                      | -$30.00             |
| **Net Ending Equity**  | $70,070.00                      | $31,470.00                   | $101,540.00         |

**Attribution Summary:**
The composed backtest separates positions cleanly under `usdc-reserve` and
`xlm-growth`. When using the standalone `allocateCapital` helper for apportionment,
the largest-remainder allocator guarantees zero cash dust during capital allocation,
while snapshot tracking attributes asset equity and return trajectories to each
member independently.
